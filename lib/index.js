// dsh-opencode-go-header
//
// Host plugin: automatically attach an `x-opencode-session` header to model
// requests that are routed to an OpenCode / OpenCode Go provider route.
//
// OpenCode's relay pins every request that shares the same
// `x-opencode-session` value to the same upstream backend, which keeps its
// prompt cache warm across the turns of one conversation. The value only has
// to be opaque and stable per conversation, so by default we reuse the DSH
// session id that already travels with each model call (the same identity the
// official DeepSeek adapter sends as `x-deepseek-harness-session-id`).
//
// How it works:
//   1. Listen on the `llm/stream` waterfall. Calls whose `options.provider`
//      names a configured OpenCode route and which carry a `sessionId` are
//      driven through an AsyncLocalStorage store holding the header value.
//   2. `globalThis.fetch` is patched once. While a store is active the patch
//      merges `x-opencode-session: <value>` into matching OpenCode request
//      headers (unless the request already carries the header).
//   3. Both registrations are fiber-scoped ctx effects, so plugin stop /
//      update / unload restores the original fetch and removes the listener.
//
// Requests that are NOT routed to an OpenCode provider, or that carry no
// session id (some auxiliary hand-built calls), pass through untouched.

import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { appendFile } from 'node:fs/promises'

export const name = 'opencode-go-session-header'

// Activate only after the abstract `llm` service exists, so the waterfall
// event we listen on is already registered by its provider.
export const inject = ['llm']

const SESSION_HEADER = 'x-opencode-session'
const DEFAULT_URL_PREFIXES = ['https://opencode.ai/zen']
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 20
const fetchPatchStack = []
let fetchPatchBase

// Provider routes OpenCode(Go) requests are served under. A route naming an
// installed pi-ai catalog provider keeps that provider's id as its route key,
// so both catalog ids are covered; users who route OpenCode through a custom
// provider key add it through config.
const DEFAULT_PROVIDERS = ['opencode', 'opencode-go']

function resolveConfig(config = {}) {
  const providers = Array.isArray(config.providers) && config.providers.length > 0
    ? config.providers.map((value) => String(value))
    : [...DEFAULT_PROVIDERS]
  // session-id: reuse the DSH session id (stable across turns AND restarts,
  // unique per conversation). uuid: derive a process-stable random uuid per
  // DSH session id (opaque, but resets when the process restarts).
  const mode = config.mode === 'uuid' ? 'uuid' : 'session-id'
  const debug = config.debug === true
  const debugFile = typeof config.debugFile === 'string' && config.debugFile.length > 0
    ? config.debugFile
    : undefined
  const urlPrefixes = Array.isArray(config.urlPrefixes) && config.urlPrefixes.length > 0
    ? config.urlPrefixes.map((value) => String(value))
    : [...DEFAULT_URL_PREFIXES]
  return { providers: new Set(providers), mode, debug, debugFile, urlPrefixes }
}

/** Fire-and-forget append of one debug record; failures only log a warning. */
function recordDebug(ctx, file, entry) {
  appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8').catch((error) => {
    ctx.logger.warn('[opencode-go-session-header] debugFile write failed: %s', error?.message ?? String(error))
  })
}

/** Derive the opaque header value for one DSH session id. */
export function headerValueFor(sessionId, mode, table) {
  const raw = String(sessionId)
  if (raw.length === 0) return undefined
  if (mode !== 'uuid') return raw
  let value = table.get(raw)
  if (value === undefined) {
    value = randomUUID()
    table.set(raw, value)
  }
  return value
}

/**
 * Wrap a downstream async iterable so every pull executes inside an
 * AsyncLocalStorage store. Async generators and the promises they create
 * inherit the store as long as the generator body is driven from a pull made
 * inside `als.run`, which is exactly what this wrapper does per `next()`.
 */
export function withStore(iterable, store, als) {
  const iterator = typeof iterable[Symbol.asyncIterator] === 'function'
    ? iterable[Symbol.asyncIterator]()
    : iterable
  return {
    [Symbol.asyncIterator]() {
      return this
    },
    async next() {
      return als.run(store, () => iterator.next())
    },
    async return(value) {
      if (typeof iterator.return === 'function') {
        try {
          return await als.run(store, () => iterator.return(value))
        } catch {
          // The downstream stream may already be torn down; treat as done.
        }
      }
      return { done: true, value }
    },
    async throw(error) {
      if (typeof iterator.throw === 'function') {
        return als.run(store, () => iterator.throw(error))
      }
      throw error
    },
  }
}

/** True when the outgoing request already carries the session header. */
function hasSessionHeader(input, init) {
  const source = init?.headers
    ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined)
  if (source === undefined) return false
  try {
    return new Headers(source).has(SESSION_HEADER)
  } catch {
    return false
  }
}

/** Extract a fetch input URL without reading or changing its headers. */
function requestUrl(input) {
  if (typeof input === 'string') return input
  if (typeof URL !== 'undefined' && input instanceof URL) return input.href
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url
  if (input !== null && typeof input === 'object' && typeof input.url === 'string') return input.url
  return undefined
}

function requestMethod(input, init) {
  if (init?.method !== undefined) return String(init.method).toUpperCase()
  if (typeof Request !== 'undefined' && input instanceof Request) return input.method
  return 'GET'
}

function normalizedPrefixPath(prefix) {
  const path = new URL(prefix).pathname.replace(/\/$/, '')
  return path || '/'
}

/** Match a request against an absolute endpoint prefix by origin and path. */
function matchesUrlPrefix(url, prefixes) {
  try {
    const actual = new URL(url)
    return prefixes.some((prefix) => {
      const expected = new URL(prefix)
      const path = normalizedPrefixPath(prefix)
      return actual.origin === expected.origin
        && (path === '/' || actual.pathname === path || actual.pathname.startsWith(`${path}/`))
    })
  } catch {
    return false
  }
}

/** Keep the one-shot GET model listing outside the session-header scope. */
function isModelListRequest(url, input, init, prefixes) {
  if (requestMethod(input, init) !== 'GET') return false
  try {
    const actual = new URL(url)
    return prefixes.some((prefix) => {
      const expected = new URL(prefix)
      const path = normalizedPrefixPath(prefix)
      const modelsPath = path === '/' ? '/models' : `${path}/models`
      return actual.origin === expected.origin && actual.pathname === modelsPath
    })
  } catch {
    return false
  }
}

function redirectTarget(response, request) {
  if (!response || !REDIRECT_STATUSES.has(response.status)) return undefined
  const location = response.headers?.get?.('location')
  if (location === null || location === undefined) return undefined
  try {
    return new URL(location, request.url).href
  } catch {
    return undefined
  }
}

/** Build a manually controlled redirect request without consuming the source body. */
function makeRedirectRequest(request, url, status, keepSession, redirect) {
  const switchesToGet = (
    (status === 301 || status === 302) && request.method === 'POST'
  ) || (
    status === 303 && request.method !== 'GET' && request.method !== 'HEAD'
  )
  const method = switchesToGet ? 'GET' : request.method
  const headers = new Headers(request.headers)
  if (!keepSession) headers.delete(SESSION_HEADER)
  if (switchesToGet) headers.delete('content-length')

  const options = {
    method,
    headers,
    redirect,
    credentials: request.credentials,
    cache: request.cache,
    integrity: request.integrity,
    keepalive: request.keepalive,
    mode: request.mode,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    signal: request.signal,
  }
  if (method !== 'GET' && method !== 'HEAD' && request.body !== null) {
    const body = request.clone()
    options.body = body.body
    options.duplex = body.duplex
  }
  return new Request(url, options)
}

/** Follow redirects while retaining the session header only within configured endpoints. */
async function fetchWithScopedRedirects(original, thisArg, request, prefixes) {
  let current = request
  for (let redirects = 0; ; redirects += 1) {
    const response = await original.call(thisArg, current.clone())
    const target = redirectTarget(response, current)
    if (target === undefined) return response
    if (redirects >= MAX_REDIRECTS) throw new TypeError('fetch failed: maximum redirect count exceeded')

    const inScope = matchesUrlPrefix(target, prefixes)
    const candidate = makeRedirectRequest(current, target, response.status, inScope, 'manual')
    const keepSession = inScope && !isModelListRequest(target, candidate, undefined, prefixes)
    current = keepSession
      ? candidate
      : makeRedirectRequest(current, target, response.status, false, 'follow')
    if (!keepSession) return original.call(thisArg, current)
  }
}

/**
 * Build a patched fetch that injects the header while a store is active and
 * the request targets a configured OpenCode endpoint.
 * Header precedence mirrors native fetch: when `init.headers` is present it
 * wins; otherwise a Request's own headers are the base.
 */
export function patchFetch(original, als, urlPrefixes = DEFAULT_URL_PREFIXES) {
  return function patchedFetch(input, init) {
    const state = als.getStore()
    const url = requestUrl(input)
    if (
      state
      && url !== undefined
      && matchesUrlPrefix(url, urlPrefixes)
      && !isModelListRequest(url, input, init, urlPrefixes)
      && !hasSessionHeader(input, init)
    ) {
      const headers = new Headers(
        init?.headers
          ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined),
      )
      headers.set(SESSION_HEADER, state.value)
      const requestedRedirect = init?.redirect
        ?? (typeof Request !== 'undefined' && input instanceof Request ? input.redirect : 'follow')
      if (requestedRedirect !== 'follow') {
        return original.call(this, input, { ...init, headers })
      }
      const request = new Request(input, { ...init, headers, redirect: 'manual' })
      return fetchWithScopedRedirects(original, this, request, urlPrefixes)
    }
    return original.apply(this, arguments)
  }
}

export function apply(ctx, config) {
  const { providers, mode, debug, debugFile, urlPrefixes } = resolveConfig(config)
  const als = new AsyncLocalStorage()
  const uuidBySession = new Map()

  const originalFetch = globalThis.fetch
  if (typeof originalFetch !== 'function') {
    ctx.logger.warn('[opencode-go-session-header] globalThis.fetch is unavailable; cannot inject x-opencode-session')
    return
  }

  const patched = patchFetch(originalFetch, als, urlPrefixes)

  ctx.effect(() => {
    if (fetchPatchStack.length === 0) fetchPatchBase = globalThis.fetch
    fetchPatchStack.push(patched)
    globalThis.fetch = patched
    ctx.logger.info(
      '[opencode-go-session-header] active for providers [%s] with mode %s',
      [...providers].join(', '),
      mode,
    )
    return () => {
      const index = fetchPatchStack.indexOf(patched)
      if (index < 0) return
      const wasCurrent = globalThis.fetch === patched
      fetchPatchStack.splice(index, 1)
      if (wasCurrent) globalThis.fetch = fetchPatchStack.at(-1) ?? fetchPatchBase
      if (fetchPatchStack.length === 0) fetchPatchBase = undefined
    }
  }, 'opencode-go-session-header.fetch-patch')

  ctx.on('llm/stream', (options, next) => {
    if (options === undefined || options === null || typeof options !== 'object') return next()
    if (!providers.has(String(options.provider))) return next()
    const sessionId = options.sessionId
    if (sessionId === undefined || sessionId === null) return next()
    const value = headerValueFor(sessionId, mode, uuidBySession)
    if (value === undefined) return next()

    // Reaching the adapter is the only way the actual HTTP request happens;
    // `next()` returns the downstream (lazy) stream. Call it exactly once,
    // then drive its iterator from inside the store.
    let downstream
    try {
      downstream = next()
    } catch (error) {
      // Let the caller handle an adapter dispatch failure as it normally would.
      throw error
    }
    if (downstream === undefined || downstream === null) return downstream
    if (typeof downstream[Symbol.asyncIterator] !== 'function') return downstream

    if (debug || debugFile !== undefined) {
      const entry = {
        ts: new Date().toISOString(),
        provider: options.provider,
        model: options.model,
        session: String(sessionId),
        header: SESSION_HEADER,
        value,
      }
      if (debugFile !== undefined) recordDebug(ctx, debugFile, entry)
      if (debug) {
        ctx.logger.info(
          '[opencode-go-session-header] streaming provider "%s" with %s=%s',
          options.provider,
          SESSION_HEADER,
          value,
        )
      }
    }
    return withStore(downstream, { value }, als)
  }, { prepend: true })
}

export default { name, inject, apply }
