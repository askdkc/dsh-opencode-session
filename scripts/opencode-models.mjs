// Pure logic for refreshing the built-in `opencode` / `opencode-go` model
// lists from the official OpenCode endpoints, joined with Models.dev
// metadata the way dsh-opencode does.
//
// No dependencies, no network, no filesystem here: fetching and output live
// in refresh-opencode-models.mjs so tests drive these functions with fixtures.

/** Official model-list endpoints, mirroring dsh-opencode's SOURCES. */
export const OFFICIAL_URLS = {
  zen: 'https://opencode.ai/zen/v1/models',
  go: 'https://opencode.ai/zen/go/v1/models',
}

/** Shared Models.dev metadata document. */
export const METADATA_URL = 'https://models.dev/api.json'

/** Models.dev provider slices holding Zen / Go metadata. */
export const METADATA_PROVIDERS = { zen: 'opencode', go: 'opencode-go' }

/**
 * Models.dev SDK identifiers verified against the wire APIs OpenCode Zen /
 * Go actually expose. Anything else keeps the model visible but without a
 * derivable protocol. Mirrors dsh-opencode's SDK_WIRE_APIS.
 */
export const NPM_WIRE_APIS = {
  '@ai-sdk/openai-compatible': 'openai-completions',
  '@ai-sdk/openai': 'openai-responses',
  '@ai-sdk/anthropic': 'anthropic-messages',
  '@ai-sdk/google': 'google-generative-ai',
}

/** Input modalities a DSH pi-ai route can carry. */
export const SUPPORTED_INPUT = ['text', 'image']

/**
 * Validate an official `/models` response body.
 * @param body - decoded JSON value.
 * @param url - source URL, for diagnostics.
 * @returns model ids in listed order, deduplicated.
 */
export function parseOfficialList(body, url) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error(`GET ${url} returned a body that is not a JSON object`)
  }
  const data = body.data
  if (!Array.isArray(data)) {
    throw new Error(`GET ${url} returned a body without a data array`)
  }
  const ids = []
  const seen = new Set()
  for (const entry of data) {
    const id = entry !== null && typeof entry === 'object' ? entry.id : undefined
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`GET ${url} returned a data entry without an id`)
    }
    if (!seen.has(id)) {
      seen.add(id)
      ids.push(id)
    }
  }
  return ids
}

/**
 * Validate one Models.dev provider slice into per-model facts.
 * Unknown extra fields are ignored; a consumed field of the wrong type is a
 * refusal, not a silent default.
 * @param body - decoded api.json value.
 * @param providerId - slice to extract (`opencode` / `opencode-go`).
 * @returns model facts by exact model id.
 */
export function parseMetadataSlice(body, providerId) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error(`metadata document is not a JSON object`)
  }
  const provider = body[providerId]
  if (typeof provider !== 'object' || provider === null || Array.isArray(provider)) {
    throw new Error(`metadata document has no provider "${providerId}"`)
  }
  const rawModels = provider.models
  if (typeof rawModels !== 'object' || rawModels === null || Array.isArray(rawModels)) {
    throw new Error(`metadata provider "${providerId}" has no models dict`)
  }
  const defaultNpm = typeof provider.npm === 'string' && provider.npm.length > 0 ? provider.npm : undefined
  const out = new Map()
  for (const [id, raw] of Object.entries(rawModels)) {
    if (id.length === 0 || typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const npm = readNpm(raw.provider) ?? defaultNpm
    const api = npm !== undefined ? NPM_WIRE_APIS[npm] : undefined
    const limit = readLimit(raw.limit)
    const input = readInput(raw.modalities)
    out.set(id, {
      ...typeof raw.name === 'string' && raw.name.length > 0 ? { name: raw.name } : {},
      ...api !== undefined ? { api } : {},
      ...limit?.context !== undefined ? { contextWindow: limit.context } : {},
      ...limit?.output !== undefined ? { maxTokens: limit.output } : {},
      ...input !== undefined ? { input } : {},
    })
  }
  return out
}

/** Read a models.dev per-model `provider` dict's npm override. */
function readNpm(provider) {
  if (typeof provider !== 'object' || provider === null || Array.isArray(provider)) return undefined
  return typeof provider.npm === 'string' && provider.npm.length > 0 ? provider.npm : undefined
}

/** Read the validated `limit` dict. */
function readLimit(limit) {
  if (typeof limit !== 'object' || limit === null || Array.isArray(limit)) return undefined
  const out = {}
  if (Number.isSafeInteger(limit.context) && limit.context > 0) out.context = limit.context
  if (Number.isSafeInteger(limit.output) && limit.output > 0) out.output = limit.output
  return out
}

/** Read input modalities intersected with what a DSH route can carry. */
function readInput(modalities) {
  if (typeof modalities !== 'object' || modalities === null || Array.isArray(modalities)) return undefined
  if (!Array.isArray(modalities.input)) return undefined
  const declared = new Set(modalities.input.filter(entry => typeof entry === 'string'))
  return SUPPORTED_INPUT.filter(modality => declared.has(modality))
}

/**
 * Join one product's official ids with metadata into profile entries.
 *
 * Known ids (present in the installed pi-ai catalog) stay bare so every
 * curated field keeps inheriting; unknown ids carry the explicit fields a
 * catalog route needs, with the wire protocol hoisted to the route when all
 * unknown ids agree on one.
 *
 * @param officialIds - live ids in listed order.
 * @param metadata - models.dev facts by id.
 * @param installedIds - ids the installed pi-ai catalog describes (empty when unavailable).
 * @returns entries in official order plus diagnostics.
 */
export function joinModelEntries(officialIds, metadata, installedIds) {
  const entries = []
  const unknownIds = []
  const noMetadataIds = []
  const unknownApis = new Set()
  for (const id of officialIds) {
    if (installedIds.has(id)) {
      entries.push({ id })
      continue
    }
    unknownIds.push(id)
    const meta = metadata.get(id)
    if (meta === undefined) {
      noMetadataIds.push(id)
      entries.push({ id })
      continue
    }
    if (meta.api !== undefined) unknownApis.add(meta.api)
    entries.push({
      id,
      ...meta.name !== undefined ? { name: meta.name } : {},
      ...meta.contextWindow !== undefined ? { contextWindow: meta.contextWindow } : {},
      ...meta.maxTokens !== undefined ? { maxTokens: meta.maxTokens } : {},
      ...meta.input !== undefined ? { input: [...meta.input] } : {},
    })
  }
  // A route carries exactly one `api`, and only models the installed catalog
  // does not describe read it — known entries keep their own protocol — so it
  // is emittable only when every unknown id derives the same one.
  const withApi = unknownIds.filter(id => metadata.get(id)?.api !== undefined)
  const routeApi = unknownIds.length > 0 && withApi.length === unknownIds.length && unknownApis.size === 1
    ? [...unknownApis][0]
    : undefined
  return { entries, unknownIds, noMetadataIds, routeApi }
}

/** Quote a scalar for the generated YAML; always safe, never bare. */
function yq(value) {
  return JSON.stringify(value)
}

/**
 * Render the settings-section fragment for provider rows.
 * @param generated - per-product join results keyed by DSH route id.
 * @param header - comment lines (without `#`) placed at the top.
 * @returns YAML text with one trailing newline.
 */
export function renderSettingsFragment(generated, header) {
  const lines = [...header.map(line => `# ${line}`)]
  lines.push('llm-pi-ai:')
  lines.push('  providers:')
  for (const [route, result] of Object.entries(generated)) {
    lines.push(`    ${route}:`)
    if (result.routeApi !== undefined) {
      lines.push(`      api: ${result.routeApi}`)
    }
    if (result.entries.length === 0) {
      lines.push('      models: []')
      continue
    }
    lines.push('      models:')
    for (const entry of result.entries) {
      lines.push(`        - id: ${yq(entry.id)}`)
      if (entry.name !== undefined) lines.push(`          name: ${yq(entry.name)}`)
      if (entry.contextWindow !== undefined) lines.push(`          contextWindow: ${entry.contextWindow}`)
      if (entry.maxTokens !== undefined) lines.push(`          maxTokens: ${entry.maxTokens}`)
      if (entry.input !== undefined) lines.push(`          input: [${entry.input.map(yq).join(', ')}]`)
    }
  }
  return `${lines.join('\n')}\n`
}
