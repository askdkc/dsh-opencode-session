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

## Development

```sh
node --check lib/index.js
npm test
```

## License

MIT
