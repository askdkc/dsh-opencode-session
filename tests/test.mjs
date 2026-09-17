// Local behavioral test for dsh-opencode-go-header without a full DSH boot.
// Spins up an HTTP echo server, registers the plugin's apply() against a fake
// ctx, then drives 'llm/stream' waterfalls the way the llm service would.
//
// Run: node tests/test.mjs

import assert from 'node:assert/strict'
import http from 'node:http'
import plugin from '../lib/index.js'
import { isAuthGuidanceError, sanitizeAuthMessage } from '../lib/index.js'

const failures = []
function check(name, fn) {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`FAIL - ${name}\n    ${error.message}`)
  }
}

// ---- fake cordis ctx (only what apply() touches) ----
function fakeCtx() {
  const listeners = new Map()
  const ctx = {
    listeners,
    logger: {
      info() {},
      warn() {},
      error() {},
    },
    effect(fn) {
      const cleanup = fn()
      ctx.cleanups.push(cleanup)
      return () => cleanup?.()
    },
    cleanups: [],
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(listener)
      return () => {
        const list = listeners.get(name) ?? []
        const i = list.indexOf(listener)
        if (i >= 0) list.splice(i, 1)
      }
    },
  }
  return ctx
}

// The plugin rewrites globalThis.fetch on apply and restores on cleanup, so
// snapshot it here and always restore before exiting.
const realFetch = globalThis.fetch

function echoServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ url: req.url, headers: req.headers }))
      })
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

function redirectServer(location) {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(302, { location })
      res.end()
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

const { server, url } = await echoServer()
const { server: outsideServer, url: outsideUrl } = await echoServer()
const { server: outsideRedirectServer, url: outsideRedirectUrl } = await redirectServer(`${outsideUrl}/redirect-target`)
const { server: insideRedirectServer, url: insideRedirectUrl } = await redirectServer(`${url}/redirect-target`)

try {
  // ---- apply with default-ish config (only opencode-go for clarity) ----
  const ctx = fakeCtx()
  let ctx2
  plugin.apply(ctx, { providers: ['opencode-go'], mode: 'session-id', urlPrefixes: [url] })
  const llmStream = ctx.listeners.get('llm/stream')[0]

  // Adapter stream shape: an async generator that performs one provider
  // request through (patched) global fetch, then yields a chunk carrying the
  // echoed request headers.
  const adapterStream = async function* (tag) {
    const res = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    })
    const echoed = await res.json()
    yield { tag, echoed }
  }

  // Emulate ctx.llm.stream dispatch: waterfall listener receives (options, next).
  const streamCall = (provider, sessionId, initHeaders) => {
    const next = () => adapterStream(`${provider}:${sessionId ?? 'none'}`)
    return llmStream(
      { provider, model: 'm', sessionId, messages: [], system: '' },
      next,
    )
  }

  // 1) opencode-go + session id -> header present with the session value.
  {
    const session = 'session-11111111-2222-3333-4444-555555555555'
    const chunks = []
    for await (const chunk of streamCall('opencode-go', session)) chunks.push(chunk)
    const echoed = chunks[0].echoed.headers
    check('opencode-go request carries x-opencode-session = session id', () => {
      assert.equal(echoed['x-opencode-session'], session)
    })
  }

  // 2) opencode-go + session id -> same value on the second request (stable).
  {
    const session = 'session-11111111-2222-3333-4444-555555555555'
    const chunks = []
    for await (const chunk of streamCall('opencode-go', session)) chunks.push(chunk)
    check('opencode-go session value is stable across requests', () => {
      assert.equal(chunks[0].echoed.headers['x-opencode-session'], session)
    })
  }

  // 3) Non-opencode provider -> no header injected.
  {
    const chunks = []
    for await (const chunk of streamCall('deepseek-official', 'session-aaaaaaaa-0000-0000-0000-000000000000')) chunks.push(chunk)
    check('non-opencode provider request is untouched', () => {
      assert.equal(chunks[0].echoed.headers['x-opencode-session'], undefined)
    })
  }

  // 4) A fetch issued OUTSIDE any llm/stream call gets no header either.
  {
    const res = await fetch(`${url}/v1/models`, { headers: { accept: 'application/json' } })
    const body = await res.json()
    check('bare fetch outside a stream call is untouched', () => {
      assert.equal(body.headers['x-opencode-session'], undefined)
    })
  }

  // 5) A model listing is excluded even when fetched inside a stream call.
  {
    const next = () => (async function* () {
      const response = await fetch(`${url}/models`)
      yield { echoed: await response.json() }
    })()
    const wrapped = llmStream({ provider: 'opencode-go', model: 'm', sessionId: 'session-models' }, next)
    const chunks = []
    for await (const chunk of wrapped) chunks.push(chunk)
    check('model listing does not receive x-opencode-session', () => {
      assert.equal(chunks[0].echoed.headers['x-opencode-session'], undefined)
    })
  }

  // 6) An explicit header set by the provider profile is preserved.
  {
    const session = 'session-22222222-2222-3333-4444-555555555555'
    const next = () => (async function* () {
      const res = await fetch(`${url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'x-opencode-session': 'preset-value' },
        body: '{}',
      })
      yield { echoed: await res.json() }
    })()
    const wrapped = llmStream({ provider: 'opencode-go', model: 'm', sessionId: session }, next)
    const chunks = []
    for await (const chunk of wrapped) chunks.push(chunk)
    check('caller-provided x-opencode-session header wins', () => {
      assert.equal(chunks[0].echoed.headers['x-opencode-session'], 'preset-value')
    })
  }

  // 7) uuid mode: distinct sessions -> distinct uuids; same session -> same uuid.
  {
    ctx2 = fakeCtx()
    plugin.apply(ctx2, { providers: ['opencode-go'], mode: 'uuid', urlPrefixes: [url] })
    const listener2 = ctx2.listeners.get('llm/stream')[0]
    const one = []
    for await (const c of listener2({ provider: 'opencode-go', sessionId: 'session-u1' }, () => adapterStream('u1'))) one.push(c)
    const two = []
    for await (const c of listener2({ provider: 'opencode-go', sessionId: 'session-u1' }, () => adapterStream('u1-again'))) two.push(c)
    const three = []
    for await (const c of listener2({ provider: 'opencode-go', sessionId: 'session-u2' }, () => adapterStream('u2'))) three.push(c)
    const v1 = one[0].echoed.headers['x-opencode-session']
    const v2 = two[0].echoed.headers['x-opencode-session']
    const v3 = three[0].echoed.headers['x-opencode-session']
    check('uuid mode: stable per session, unique across sessions', () => {
      assert.equal(v1, v2)
      assert.notEqual(v1, v3)
      assert.match(v1, /^[0-9a-f-]{36}$/)
    })
  }

  // 8) no sessionId -> no header (auxiliary calls pass through).
  {
    const chunks = []
    for await (const chunk of streamCall('opencode-go', undefined)) chunks.push(chunk)
    check('opencode-go request without sessionId is untouched', () => {
      assert.equal(chunks[0].echoed.headers['x-opencode-session'], undefined)
    })
  }

  // 9) plugin unload restores the fetch that was installed before its apply.
  // Instances from earlier groups still hold the patched fetch (the plugin is
  // a singleton in real DSH, so a fresh scenario needs those cleaned up
  // first, in reverse application order: ctx2 then ctx).
  {
    for (const cleanup of ctx2.cleanups) cleanup()
    for (const cleanup of ctx.cleanups) cleanup()
    assert.equal(globalThis.fetch, realFetch)

    const ctx3 = fakeCtx()
    plugin.apply(ctx3, { providers: ['opencode-go'] })
    assert.notEqual(globalThis.fetch, realFetch)
    for (const cleanup of ctx3.cleanups) cleanup()
    check('plugin unload restores globalThis.fetch', () => {
      assert.equal(globalThis.fetch, realFetch)
    })

    const first = fakeCtx()
    const second = fakeCtx()
    plugin.apply(first, { providers: ['opencode-go'], urlPrefixes: [url] })
    plugin.apply(second, { providers: ['opencode-go'], urlPrefixes: [url] })
    for (const cleanup of first.cleanups) cleanup()
    check('non-LIFO plugin unload keeps the active fetch patch', () => {
      assert.notEqual(globalThis.fetch, realFetch)
    })
    for (const cleanup of second.cleanups) cleanup()
    assert.equal(globalThis.fetch, realFetch)
  }

  // 10) concurrent conversations keep their own header value even when their
  // provider streams interleave at await boundaries.
  {
    const ctx4 = fakeCtx()
    plugin.apply(ctx4, { providers: ['opencode-go'], mode: 'session-id', urlPrefixes: [url] })
    const listener4 = ctx4.listeners.get('llm/stream')[0]
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    const make = (tag) => async function* () {
      const first = await fetch(`${url}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ tag }) })
      yield { tag: `${tag}-1`, echoed: await first.json() }
      await sleep(25)
      const second = await fetch(`${url}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ tag }) })
      yield { tag: `${tag}-2`, echoed: await second.json() }
    }

    const iterA = listener4({ provider: 'opencode-go', sessionId: 'session-conv-a' }, make('a'))[Symbol.asyncIterator]()
    const iterB = listener4({ provider: 'opencode-go', sessionId: 'session-conv-b' }, make('b'))[Symbol.asyncIterator]()

    // Pull both conversations concurrently so their internal awaits (fetch,
    // sleep) overlap; each request must still carry its own conversation id.
    const [a1, b1] = await Promise.all([iterA.next(), iterB.next()])
    const [a2, b2] = await Promise.all([iterA.next(), iterB.next()])

    check('concurrent conversations keep distinct x-opencode-session values', () => {
      assert.equal(a1.value.echoed.headers['x-opencode-session'], 'session-conv-a')
      assert.equal(a2.value.echoed.headers['x-opencode-session'], 'session-conv-a')
      assert.equal(b1.value.echoed.headers['x-opencode-session'], 'session-conv-b')
      assert.equal(b2.value.echoed.headers['x-opencode-session'], 'session-conv-b')
    })
    for (const cleanup of ctx4.cleanups) cleanup()
    assert.equal(globalThis.fetch, realFetch)
  }

  // 11) A matching provider stream does not stamp unrelated URLs.
  {
    const ctx5 = fakeCtx()
    plugin.apply(ctx5, { providers: ['opencode-go'], urlPrefixes: [url] })
    const listener5 = ctx5.listeners.get('llm/stream')[0]
    const next = () => (async function* () {
      const response = await fetch(`${outsideUrl}/outside`)
      yield { echoed: await response.json() }
    })()
    const chunks = []
    for await (const chunk of listener5({ provider: 'opencode-go', sessionId: 'session-unrelated-url' }, next)) chunks.push(chunk)
    check('matching provider does not modify unrelated URLs', () => {
      assert.equal(chunks[0].echoed.headers['x-opencode-session'], undefined)
    })
    for (const cleanup of ctx5.cleanups) cleanup()
    assert.equal(globalThis.fetch, realFetch)
  }

  // 12) A redirect outside the configured endpoint does not forward the header.
  {
    const ctx6 = fakeCtx()
    plugin.apply(ctx6, { providers: ['opencode-go'], urlPrefixes: [outsideRedirectUrl] })
    const listener6 = ctx6.listeners.get('llm/stream')[0]
    const next = () => (async function* () {
      const response = await fetch(`${outsideRedirectUrl}/redirect`, { method: 'POST', body: '{}' })
      yield { echoed: await response.json() }
    })()
    const chunks = []
    for await (const chunk of listener6({ provider: 'opencode-go', sessionId: 'session-redirect-outside' }, next)) chunks.push(chunk)
    check('redirect outside configured endpoint drops x-opencode-session', () => {
      assert.equal(chunks[0].echoed.headers['x-opencode-session'], undefined)
    })
    for (const cleanup of ctx6.cleanups) cleanup()
    assert.equal(globalThis.fetch, realFetch)
  }

  // 13) A redirect within configured endpoints keeps the conversation header.
  {
    const ctx7 = fakeCtx()
    plugin.apply(ctx7, { providers: ['opencode-go'], urlPrefixes: [insideRedirectUrl, url] })
    const listener7 = ctx7.listeners.get('llm/stream')[0]
    const next = () => (async function* () {
      const response = await fetch(`${insideRedirectUrl}/redirect`)
      yield { echoed: await response.json() }
    })()
    const chunks = []
    for await (const chunk of listener7({ provider: 'opencode-go', sessionId: 'session-redirect-inside' }, next)) chunks.push(chunk)
    check('redirect within configured endpoints keeps x-opencode-session', () => {
      assert.equal(chunks[0].echoed.headers['x-opencode-session'], 'session-redirect-inside')
    })
    for (const cleanup of ctx7.cleanups) cleanup()
    assert.equal(globalThis.fetch, realFetch)
  }
  // 14) AUTH guidance sanitization keeps the actionable part only.
  {
    check('sanitizeAuthMessage redacts secrets but keeps URL and reason', () => {
      const out = sanitizeAuthMessage(
        'OpenAI API error (403): {"type":"DataPolicyError","message":"opt in: https://opencode.ai/workspace/wrk_123/go"} with sk-abc123 and Bearer secret-token',
      )
      assert.match(out, /DataPolicyError/)
      assert.match(out, /https:\/\/opencode\.ai\/workspace\/wrk_123\/go/)
      assert.doesNotMatch(out, /sk-abc123/)
      assert.doesNotMatch(out, /secret-token/)
      assert.match(out, /sk-<redacted>/)
    })
    check('sanitizeAuthMessage redacts api-key echoes', () => {
      const out = sanitizeAuthMessage('Authentication Fails, Your api key: sk-preview-secret is invalid')
      assert.match(out, /is invalid/)
      assert.doesNotMatch(out, /sk-preview-secret/)
    })
    check('isAuthGuidanceError matches AUTH-like failures only', () => {
      assert.equal(isAuthGuidanceError({ code: 'AUTH', message: 'anything' }), true)
      assert.equal(isAuthGuidanceError(new Error('FreeTierError: only be used from within OpenCode')), true)
      assert.equal(isAuthGuidanceError(new Error('upstream 503')), false)
    })
  }

  // 15) An AUTH downstream failure is rethrown unchanged with one sanitized log.
  {
    const warnings = []
    const ctx8 = {
      ...fakeCtx(),
      logger: { info() {}, warn(...args) { warnings.push(args.join(' ')) }, error() {} },
    }
    plugin.apply(ctx8, { providers: ['opencode-go'], mode: 'session-id', urlPrefixes: [url] })
    const listener8 = ctx8.listeners.get('llm/stream')[0]
    const failure = new Error(
      'OpenAI API error (403): {"type":"DataPolicyError","message":"requires explicit opt in: https://opencode.ai/workspace/wrk_123/go"}',
    )
    failure.code = 'AUTH'
    const next = () => (async function* () {
      yield { tag: 'before-failure' }
      throw failure
    })()
    const chunks = []
    let seen
    try {
      for await (const chunk of listener8({ provider: 'opencode-go', sessionId: 'session-auth-guidance' }, next)) {
        chunks.push(chunk)
      }
    } catch (error) {
      seen = error
    }
    check('AUTH failure propagates unchanged with sanitized guidance logged', () => {
      assert.equal(seen, failure)
      assert.equal(chunks.length, 1)
      assert.equal(warnings.length, 1)
      assert.match(warnings[0], /AUTH guidance/)
      assert.match(warnings[0], /opencode\.ai\/workspace\/wrk_123\/go/)
    })
    for (const cleanup of ctx8.cleanups) cleanup()
    assert.equal(globalThis.fetch, realFetch)
  }

  // 16) A non-AUTH failure never triggers guidance output.
  {
    const warnings = []
    const ctx9 = {
      ...fakeCtx(),
      logger: { info() {}, warn(...args) { warnings.push(args.join(' ')) }, error() {} },
    }
    plugin.apply(ctx9, { providers: ['opencode-go'], mode: 'session-id', urlPrefixes: [url] })
    const listener9 = ctx9.listeners.get('llm/stream')[0]
    const next = () => (async function* () {
      throw Object.assign(new Error('upstream 503'), { code: 'SERVER' })
    })()
    let seen
    try {
      for await (const _chunk of listener9({ provider: 'opencode-go', sessionId: 'session-no-guidance' }, next)) {}
    } catch (error) {
      seen = error
    }
    check('SERVER failure propagates without AUTH guidance', () => {
      assert.match(String(seen?.message ?? seen), /upstream 503/)
      assert.equal(warnings.length, 0)
    })
    for (const cleanup of ctx9.cleanups) cleanup()
    assert.equal(globalThis.fetch, realFetch)
  }

  // 17) authGuidance:false disables the out-of-band notice.
  {
    const warnings = []
    const ctx10 = {
      ...fakeCtx(),
      logger: { info() {}, warn(...args) { warnings.push(args.join(' ')) }, error() {} },
    }
    plugin.apply(ctx10, {
      providers: ['opencode-go'],
      mode: 'session-id',
      urlPrefixes: [url],
      authGuidance: false,
    })
    const listener10 = ctx10.listeners.get('llm/stream')[0]
    const failure = Object.assign(new Error('FreeTierError: can only be used from within OpenCode'), { code: 'AUTH' })
    let seen
    try {
      for await (const _chunk of listener10({ provider: 'opencode-go', sessionId: 'session-muted' }, () => (async function* () { throw failure })())) {}
    } catch (error) {
      seen = error
    }
    check('authGuidance:false keeps the error but stays silent', () => {
      assert.equal(seen, failure)
      assert.equal(warnings.length, 0)
    })
    for (const cleanup of ctx10.cleanups) cleanup()
    assert.equal(globalThis.fetch, realFetch)
  }
  // 18) An AUTH failure arriving as an error finish chunk (pi-ai style: never
  // throws mid-stream) is reported once and passed through untouched.
  {
    const warnings = []
    const ctx11 = {
      ...fakeCtx(),
      logger: { info() {}, warn(...args) { warnings.push(args.join(' ')) }, error() {} },
    }
    plugin.apply(ctx11, { providers: ['opencode-go'], mode: 'session-id', urlPrefixes: [url] })
    const listener11 = ctx11.listeners.get('llm/stream')[0]
    const finish = {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          code: 'AUTH',
          message: 'OpenAI API error (403): {"type":"DataPolicyError","message":"requires explicit opt in: https://opencode.ai/workspace/wrk_123/go"}',
        },
      },
    }
    const next = () => (async function* () {
      yield { tag: 'text-seen' }
      yield finish
    })()
    const chunks = []
    for await (const chunk of listener11({ provider: 'opencode-go', sessionId: 'session-finish-auth' }, next)) {
      chunks.push(chunk)
    }
    check('error finish chunk is reported once and passed through', () => {
      assert.equal(chunks.length, 2)
      assert.equal(chunks[1], finish)
      assert.equal(warnings.length, 1)
      assert.match(warnings[0], /AUTH guidance/)
      assert.match(warnings[0], /opencode\.ai\/workspace\/wrk_123\/go/)
    })
    for (const cleanup of ctx11.cleanups) cleanup()
    assert.equal(globalThis.fetch, realFetch)
  }

  // 19) A successful stop finish chunk never triggers guidance output.
  {
    const warnings = []
    const ctx12 = {
      ...fakeCtx(),
      logger: { info() {}, warn(...args) { warnings.push(args.join(' ')) }, error() {} },
    }
    plugin.apply(ctx12, { providers: ['opencode-go'], mode: 'session-id', urlPrefixes: [url] })
    const listener12 = ctx12.listeners.get('llm/stream')[0]
    const next = () => (async function* () {
      yield { tag: 'text-seen' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
    const chunks = []
    for await (const chunk of listener12({ provider: 'opencode-go', sessionId: 'session-finish-ok' }, next)) {
      chunks.push(chunk)
    }
    check('stop finish chunk stays silent', () => {
      assert.equal(chunks.length, 2)
      assert.equal(warnings.length, 0)
    })
    for (const cleanup of ctx12.cleanups) cleanup()
    assert.equal(globalThis.fetch, realFetch)
  }
} finally {
  server.close()
  outsideServer.close()
  outsideRedirectServer.close()
  insideRedirectServer.close()
  globalThis.fetch = realFetch
}

if (failures.length > 0) {
  console.error(`\n${failures.length} test(s) failed`)
  process.exit(1)
}
console.log('\nall tests passed')
