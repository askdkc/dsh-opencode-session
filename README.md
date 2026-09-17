# dsh-opencode-session

Adds a stable `x-opencode-session` header to OpenCode and OpenCode Go requests
made by [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

The value is stable for each DSH conversation, which fixes
`400 MissingSessionID` errors and preserves OpenCode session affinity.

## Usage

Install the plugin from a DeepSeek Harness checkout:

```sh
pnpm dsh plugin --profile web add github:askdkc/dsh-opencode-session
```

Replace `web` with the target profile name, then restart that profile.

Install it in every profile that uses OpenCode providers. Profiles load plugins
independently.

## Configuration

The default configuration covers `opencode` and `opencode-go` and targets
`https://opencode.ai/zen`.

For a custom gateway, add a row with the same id to the profile's
`cordis.patch.yml`:

```yaml
- insert:
    - id: opencode-go-session-header
      name: dsh-opencode-session
      config:
        providers: [opencode, opencode-go]
        urlPrefixes: [https://opencode.ai/zen/v1]
        mode: session-id
```

Use `mode: uuid` for an opaque process-local value. Requests outside
`urlPrefixes`, `GET /models`, and requests that already have the header are
left unchanged.

The session value comes from the explicit `sessionId` on the model call when
present. Auxiliary calls that omit it (for example experimental auto-review)
fall back to the current initiating agent session id
(`ctx.agents.currentInitiator()`), so they stay pinned to the same OpenCode
backend as the conversation. A call that supplies neither an explicit
`sessionId` nor an initiating agent session is left untouched. An
`x-opencode-session` header already present on the request always wins.

## AUTH guidance

DSH's Chat/Trajectory UI intentionally blanks `AUTH` failure messages to avoid
echoing credentials, so `FreeTierError` and `DataPolicyError` both render as a
generic `API key is invalid`. This plugin reports the actionable part
out-of-band: on an AUTH-like downstream failure it logs one sanitized warning
to the `dsh` process console with the error type, reason, and opt-in URL, with
`sk-...`, `Bearer ...`, and `api key: ...` values redacted. The original error
is rethrown unchanged, so retry behavior and the session log are preserved.

```yaml
- insert:
    - id: opencode-go-session-header
      name: dsh-opencode-session
      config:
        authGuidance: true
        authGuidanceFile: /tmp/dsh-opencode-auth.log
```

`authGuidance: false` disables the notice. `authGuidanceFile` optionally
appends the same sanitized record as JSON lines.

## Model refresh (same provider, latest models)

`scripts/refresh-opencode-models.mjs` fetches the live OpenCode model lists
and emits a settings fragment for the built-in `opencode` / `opencode-go`
routes — the same provider ids, refreshed catalog, no new provider and no DSH
core change:

```sh
node scripts/refresh-opencode-models.mjs --out opencode-models.yml
```

The script joins each official list
(`https://opencode.ai/zen/v1/models`, `https://opencode.ai/zen/go/v1/models`)
with Models.dev metadata (`https://models.dev/api.json`, same npm-to-protocol
mapping dsh-opencode uses). Ids the installed pi-ai catalog already describes
stay bare entries so every curated field keeps inheriting; new ids carry
explicit `name` / `contextWindow` / `maxTokens` / `input`, with the wire
protocol hoisted to a route-level `api` when all new ids agree on one.
`--pi-ai-dir <dir>` points at the installed `@earendil-works/pi-ai` package
for that comparison (defaults to module-graph resolution, which usually
misses — pass the DSH checkout's copy explicitly).

Merge the fragment under `llm-pi-ai.providers` in `$DSH_HOME/settings.yaml`
(Models page compatible, hot-reloaded, no restart). Arrays replace wholesale,
so the emitted list is exactly the live list; provider dicts merge per key,
leaving `apiKeyEnv` untouched. Afterwards a stale route-level `api` may need
manual removal when the script no longer emits one (merge cannot delete).

New ids without a derivable protocol stay per-model diagnostics in the Models
page instead of breaking the route — verified against the real resolver:
68/71 zen models serviceable with 3 diagnostics. `--check --out FILE` exits 1
when FILE differs, for cron use. `node scripts/refresh-opencode-models.mjs --help`
lists `--products`, `--no-metadata`, and `--timeout-ms`.

## Development

```sh
node --check lib/index.js
npm test
```

## License

MIT
