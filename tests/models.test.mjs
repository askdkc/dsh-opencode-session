// Behavioral tests for scripts/opencode-models.mjs (pure logic only).
// Run: node tests/models.test.mjs

import assert from 'node:assert/strict'
import {
  joinModelEntries,
  parseMetadataSlice,
  parseOfficialList,
  renderSettingsFragment,
} from '../scripts/opencode-models.mjs'

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

check('parseOfficialList keeps ids in order and drops duplicates', () => {
  const ids = parseOfficialList(
    { object: 'list', data: [{ id: 'b' }, { id: 'a' }, { id: 'b', created: 1 }] },
    'https://example/models',
  )
  assert.deepEqual(ids, ['b', 'a'])
})

check('parseOfficialList refuses bodies without a data array', () => {
  assert.throws(() => parseOfficialList({ data: 'x' }, 'https://example/models'), /data array/)
  assert.throws(() => parseOfficialList({ data: [{ nope: 1 }] }, 'https://example/models'), /without an id/)
  assert.throws(() => parseOfficialList([], 'https://example/models'), /not a JSON object/)
})

check('parseMetadataSlice maps npm to wire api and reads limits', () => {
  const slice = parseMetadataSlice({
    opencode: {
      npm: '@ai-sdk/openai-compatible',
      models: {
        'm-text': {
          name: 'M Text',
          limit: { context: 200000, output: 32000 },
          modalities: { input: ['text', 'image', 'pdf'] },
        },
        'm-claude': {
          limit: { context: 1000 },
          provider: { npm: '@ai-sdk/anthropic' },
        },
        'm-weird': { provider: { npm: '@acme/sdk' }, limit: { context: -5 } },
      },
    },
  }, 'opencode')
  assert.equal(slice.get('m-text').api, 'openai-completions')
  assert.equal(slice.get('m-text').contextWindow, 200000)
  assert.equal(slice.get('m-text').maxTokens, 32000)
  assert.deepEqual(slice.get('m-text').input, ['text', 'image'])
  assert.equal(slice.get('m-claude').api, 'anthropic-messages')
  assert.equal(slice.get('m-claude').maxTokens, undefined)
  assert.equal(slice.get('m-weird').api, undefined)
})

check('parseMetadataSlice refuses a missing provider slice', () => {
  assert.throws(() => parseMetadataSlice({}, 'opencode'), /no provider "opencode"/)
  assert.throws(() => parseMetadataSlice({ opencode: {} }, 'opencode'), /no models dict/)
})

check('joinModelEntries keeps known ids bare and details unknown ones', () => {
  const metadata = new Map([
    ['known', { api: 'openai-completions' }],
    ['fresh', { api: 'openai-completions', name: 'Fresh', contextWindow: 1, maxTokens: 2, input: ['text'] }],
  ])
  const result = joinModelEntries(['known', 'fresh'], metadata, new Set(['known']))
  assert.deepEqual(result.entries, [
    { id: 'known' },
    { id: 'fresh', name: 'Fresh', contextWindow: 1, maxTokens: 2, input: ['text'] },
  ])
  assert.deepEqual(result.unknownIds, ['fresh'])
  assert.deepEqual(result.noMetadataIds, [])
  assert.equal(result.routeApi, 'openai-completions')
})

check('joinModelEntries reports ids without metadata and withholds mixed route api', () => {
  const metadata = new Map([['u1', { api: 'openai-completions' }], ['u2', { api: 'anthropic-messages' }]])
  const result = joinModelEntries(['u1', 'u2', 'u3'], metadata, new Set())
  assert.deepEqual(result.unknownIds, ['u1', 'u2', 'u3'])
  assert.deepEqual(result.noMetadataIds, ['u3'])
  assert.equal(result.routeApi, undefined)
  assert.deepEqual(result.entries[2], { id: 'u3' })
})

check('renderSettingsFragment emits a mergeable section with quoted scalars', () => {
  const text = renderSettingsFragment({
    opencode: {
      routeApi: 'openai-completions',
      entries: [{ id: 'a' }, { id: 'b:b', name: 'B "x"', contextWindow: 1, maxTokens: 2, input: ['text', 'image'] }],
      unknownIds: ['b:b'],
      noMetadataIds: [],
    },
  }, ['line one'])
  assert.match(text, /^# line one\nllm-pi-ai:\n  providers:\n    opencode:\n/)
  assert.match(text, /api: openai-completions/)
  assert.match(text, /- id: "a"\n/)
  assert.match(text, /- id: "b:b"\n          name: "B \\"x\\""\n/)
  assert.match(text, /input: \["text", "image"\]/)
  assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'))
})

if (failures.length > 0) {
  console.error(`\n${failures.length} test(s) failed`)
  process.exit(1)
}
console.log('\nall model tests passed')
