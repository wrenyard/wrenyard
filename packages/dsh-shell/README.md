# @wrenyard/dsh-shell

Private **MIT** ESM package (part of the Wrenyard desktop suite, `0.1.0-dev.0`).
Ships the **Wrenyard MCP/IPC tools bridge** that gives DeepSeek Harness (DSH)
Code Mode a safe, first-class tool SDK bound to Wrenyard's public MCP/IPC
surfaces.

## Architecture

- **DSH compatibility**: pinned to `@deepseek-ai/dsh@0.1.0-rc.6`. This package
  is a Cordis plugin (`name`, `inject: ['tools']`, `async apply(ctx)`) loaded
  through DSH's public plugin/profile bundle mechanism. **No DeepSeek source is
  vendored** and no internal/private provider is bundled.
- **Desktop profile composition**: the bundled desktop shell composes this
  plugin with DSH via `cordis.patch.yml` (啾啾工坊编排者 persona, `tools mode
  code`, `includeRuntimeContext: false`) and installs the `wrenyard` agent
  preset into `$DSH_HOME/.agent-presets/wrenyard` so it appears in the Web
  模式 dropdown. DSH overwrites `agent-presets.roots` with its shipped
  standard/PTC/minimal/cordis directory, so a bundle cannot add a system
  roster root.
- **Public boundaries only**: everything goes through Wrenyard's public MCP
  (HTTP/SSE JSON-RPC) and owner-only NDJSON IPC. No Forge or Wrenyard
  implementation code is imported, and no credentials or raw environment values
  are ever logged.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `WRENYARD_MCP_URL` | `http://127.0.0.1:8787/mcp` | Wrenyard MCP HTTP/SSE endpoint |
| `WRENYARD_MCP_SENDER` | *(empty)* | Sender appended as the stable protocol sender query parameter |
| `WRENYARD_IPC_PATH` | `\\.\pipe\wrenyard.sock` (Windows), `/tmp/wrenyard.sock` (elsewhere) | Owner-only NDJSON IPC socket/pipe |
| `FOREMAN_MCP_URL` / `FOREMAN_MCP_SENDER` / `FOREMAN_IPC_PATH` | *(legacy)* | Deprecated pre-Wrenyard names, still read as fallbacks |

All three `WRENYARD_*` variables share the same `wrenyard.sock` default with
`@wrenyard/control-client` and the desktop app. The MCP/IPC wire protocols are
stable — only the product naming changed, so the legacy `FOREMAN_*` variables
continue to work.

## Fail-loud behavior

- MCP unavailable → startup fails with `Wrenyard: MCP is unavailable`.
- MCP lists no usable tools → startup fails with `Wrenyard: MCP listed no usable tools`.
- IPC unavailable → bounded warning only; the bridge continues in MCP-only mode.

DSH-internal session/work plumbing (`sessions_list`, `session_send`,
`work_send`, `work_transcript`) and all `workflow_*` tools are filtered out of
the model-visible catalog. `task_run` waits by default (internal 100ms polling
with cancellation and a 900s deadline); a synthesized `task_wait` is added when
the catalog lacks one. Read-only tools are classified for concurrent execution;
mutating tools are serialized.

## Test / pack

```sh
npm test            # node --test
npm run check       # same as test
npm run pack:check  # npm pack --dry-run
```

## License

MIT. Third-party notices for `@deepseek-ai/dsh` and Electron are preserved by
the suite; this package asserts no ownership of unverified assets.
