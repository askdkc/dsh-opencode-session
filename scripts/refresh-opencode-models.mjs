#!/usr/bin/env node
// Refresh the built-in `opencode` / `opencode-go` model lists from the live
// OpenCode endpoints, joined with Models.dev metadata the way dsh-opencode
// does, and emit a settings-section fragment for the same provider ids — no
// new provider, no DSH core change.
//
// Usage:
//   node scripts/refresh-opencode-models.mjs [--products zen,go] [--out FILE]
//     [--no-metadata] [--timeout-ms 15000] [--check] [--pi-ai-dir DIR]
//
//   --products      zen, go, or both (default both; DSH routes opencode/opencode-go)
//   --out           write the fragment to FILE instead of stdout
//   --no-metadata   skip Models.dev; unknown ids are reported without fields
//   --timeout-ms    per-request fetch timeout (default 15000)
//   --check         with --out: exit 1 when FILE differs (ignoring the timestamp line)
//   --pi-ai-dir     installed @earendil-works/pi-ai package dir; when resolvable
//                   the script separates known ids (bare entries) from unknown
//                   ones (explicit fields). Otherwise every id is a bare entry
//                   and new ids are only reported, never detailed.
//
// Apply: merge the fragment under `llm-pi-ai.providers` in $DSH_HOME/settings.yaml
// (Models page compatible, hot-reloaded, no restart). Arrays replace wholesale,
// so the emitted list is exactly the live list; provider dicts merge per key,
// leaving apiKeyEnv and siblings untouched. Verify in the Models page after
// applying: an unknown id without a derivable api fails loud at load.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  METADATA_PROVIDERS,
  METADATA_URL,
  OFFICIAL_URLS,
  joinModelEntries,
  parseMetadataSlice,
  parseOfficialList,
  renderSettingsFragment,
} from './opencode-models.mjs'

const OFFICIAL_MAX_BYTES = 1024 * 1024
const METADATA_MAX_BYTES = 32 * 1024 * 1024
const ROUTES = { zen: 'opencode', go: 'opencode-go' }

function usage() {
  return `usage: refresh-opencode-models.mjs [--products zen,go] [--out FILE] [--no-metadata] [--timeout-ms N] [--check] [--pi-ai-dir DIR]`
}

function parseArgs(argv) {
  const options = {
    products: ['zen', 'go'],
    out: undefined,
    metadata: true,
    timeoutMs: 15000,
    check: false,
    piAiDir: undefined,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--products') {
      const value = argv[i += 1]
      if (value === undefined) throw new Error(`${usage()}\n--products needs a value`)
      const products = value.split(',').map(part => part.trim()).filter(part => part.length > 0)
      if (products.length === 0 || products.some(part => part !== 'zen' && part !== 'go')) {
        throw new Error(`${usage()}\n--products accepts zen, go, or zen,go`)
      }
      options.products = [...new Set(products)]
    } else if (arg === '--out') {
      const value = argv[i += 1]
      if (value === undefined) throw new Error(`${usage()}\n--out needs a file`)
      options.out = value
    } else if (arg === '--no-metadata') {
      options.metadata = false
    } else if (arg === '--timeout-ms') {
      const value = Number(argv[i += 1])
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${usage()}\n--timeout-ms needs a positive integer`)
      options.timeoutMs = value
    } else if (arg === '--check') {
      options.check = true
    } else if (arg === '--pi-ai-dir') {
      const value = argv[i += 1]
      if (value === undefined) throw new Error(`${usage()}\n--pi-ai-dir needs a directory`)
      options.piAiDir = value
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage())
      process.exit(0)
    } else {
      throw new Error(`${usage()}\nunknown argument: ${arg}`)
    }
  }
  if (options.check && options.out === undefined) {
    throw new Error(`${usage()}\n--check needs --out`)
  }
  return options
}

/** GET JSON with a timeout and a hard cap on decoded bytes. */
async function fetchJson(url, { timeoutMs, maxBytes }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { method: 'GET', signal: controller.signal, redirect: 'error' })
    if (!response.ok) throw new Error(`GET ${url} answered HTTP ${response.status}`)
    const length = response.headers.get('content-length')
    if (length !== null && Number.isFinite(Number(length)) && Number(length) > maxBytes) {
      throw new Error(`GET ${url} declares ${length} bytes, over the ${maxBytes}-byte limit`)
    }
    const reader = response.body?.getReader()
    if (reader === undefined) throw new Error(`GET ${url} returned no body`)
    const chunks = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new Error(`GET ${url} body exceeded the ${maxBytes}-byte limit`)
      }
      chunks.push(value)
    }
    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    return JSON.parse(new TextDecoder().decode(merged))
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`GET ${url} exceeded ${timeoutMs}ms`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Best-effort load of the installed pi-ai catalog ids per product. The
 * refresh stays useful without it (every id becomes a bare entry); with it,
 * new ids get explicit fields.
 */
async function loadInstalledIds(piAiDir) {
  const empty = { zen: new Set(), go: new Set(), found: false }
  const errors = []
  // Resolve through Node so any export layout works: prefer an explicit
  // dir, otherwise whatever the module graph already provides.
  const specifiers = []
  if (piAiDir !== undefined) {
    // Direct file candidates: package self-reference is unreliable under
    // pnpm's strict layouts, so probe the usual dist shapes instead.
    for (const shape of ['dist/providers/all.js', 'providers/all.js', 'lib/providers/all.js']) {
      specifiers.push(pathToFileURL(resolve(piAiDir, shape)).href)
    }
  } else {
    const bases = [
      pathToFileURL(fileURLToPath(new URL('.', import.meta.url))).href,
      pathToFileURL(resolve(process.cwd(), 'package.json')).href,
    ]
    for (const base of [...new Set(bases)]) {
      try {
        specifiers.push(await import.meta.resolve('@earendil-works/pi-ai/providers/all', base))
      } catch (error) {
        errors.push(error)
      }
    }
  }
  for (const specifier of specifiers) {
    try {
      const catalog = await import(specifier)
      return {
        zen: new Set(catalog.getBuiltinModels('opencode').map(model => model.id)),
        go: new Set(catalog.getBuiltinModels('opencode-go').map(model => model.id)),
        found: true,
      }
    } catch (error) {
      errors.push(error)
    }
  }
  return { ...empty, errors }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const fetchOptions = url => url === METADATA_URL
    ? { timeoutMs: options.timeoutMs, maxBytes: METADATA_MAX_BYTES }
    : { timeoutMs: options.timeoutMs, maxBytes: OFFICIAL_MAX_BYTES }

  const installed = await loadInstalledIds(options.piAiDir)
  // Without the installed catalog there is no known/unknown distinction, so
  // metadata cannot target explicit fields at new ids; every id stays a bare
  // entry and truly new ids fail loud at load until detailed by hand.
  const wantMetadata = options.metadata && installed.found
  if (options.metadata && !installed.found) {
    console.error('notice: installed pi-ai catalog not found; skipping Models.dev (use --pi-ai-dir to enable detailed new-id entries)')
  }

  const official = {}
  await Promise.all(options.products.map(async (product) => {
    const url = OFFICIAL_URLS[product]
    official[product] = parseOfficialList(await fetchJson(url, fetchOptions(url)), url)
  }))

  let metadata = { zen: new Map(), go: new Map() }
  if (wantMetadata) {
    const body = await fetchJson(METADATA_URL, fetchOptions(METADATA_URL))
    metadata = {
      zen: parseMetadataSlice(body, METADATA_PROVIDERS.zen),
      go: parseMetadataSlice(body, METADATA_PROVIDERS.go),
    }
  }
  const generated = {}
  for (const product of options.products) {
    generated[ROUTES[product]] = joinModelEntries(
      official[product],
      metadata[product],
      installed[product] ?? new Set(),
    )
  }

  const stamp = new Date().toISOString()
  const header = [
    `Generated by scripts/refresh-opencode-models.mjs at ${stamp}.`,
    `Sources: ${options.products.map(product => OFFICIAL_URLS[product]).join(', ')}${wantMetadata ? `, ${METADATA_URL}` : ' (no metadata)'}.`,
    installed.found
      ? 'Installed pi-ai catalog found: known ids are bare entries, unknown ids carry explicit fields.'
      : 'Installed pi-ai catalog not found: every id is a bare entry; ids the installed catalog does not describe fail loud at load until given explicit fields.',
    'Merge under `llm-pi-ai.providers` in $DSH_HOME/settings.yaml (hot-reloaded, no restart).',
    'Arrays replace wholesale; provider dicts merge per key, leaving apiKeyEnv untouched.',
  ]
  const fragment = renderSettingsFragment(generated, header)

  const warnings = []
  for (const product of options.products) {
    const route = ROUTES[product]
    const result = generated[route]
    if (!installed.found) {
      warnings.push(`${route}: emitted ${result.entries.length} bare ids without installed-catalog comparison; ids it does not describe fail loud at load until given explicit fields`)
      continue
    }
    if (result.unknownIds.length > 0) {
      warnings.push(`${route}: ${result.unknownIds.length} new ids: ${result.unknownIds.join(', ')}`)
    }
    for (const id of result.noMetadataIds) {
      warnings.push(`${route}: "${id}" has no Models.dev metadata; inherits sizes and needs a route api when unknown`)
    }
    if (result.unknownIds.length > 0 && result.routeApi === undefined) {
      warnings.push(`${route}: new ids disagree on (or lack) a wire protocol; no route api emitted — set it manually or drop those ids`)
    }
  }

  if (options.out !== undefined) {
    const path = resolve(options.out)
    if (options.check) {
      const previous = await readFile(path, 'utf8')
      const strip = text => text.split('\n').filter(line => !line.startsWith('# Generated by')).join('\n')
      if (strip(previous) === strip(fragment)) {
        console.log(`unchanged: ${path}`)
        return
      }
      console.error(`differs: ${path}`)
      process.exit(1)
    }
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, fragment, 'utf8')
    console.log(`wrote ${path} (${officialCount(official)} models)`)
  } else {
    process.stdout.write(fragment)
  }
  for (const warning of warnings) console.error(`warning: ${warning}`)
}

function officialCount(official) {
  return Object.values(official).reduce((total, ids) => total + ids.length, 0)
}

await main().catch((error) => {
  console.error(`refresh-opencode-models: ${error?.message ?? String(error)}`)
  process.exit(1)
})
