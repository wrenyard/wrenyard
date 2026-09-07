# @wrenyard/dsh-shell

Private **MIT** ESM package (part of the Wrenyard desktop suite, `0.1.0-dev.0`).
Ships the **Wrenyard MCP/IPC tools bridge** that gives DeepSeek Harness (DSH)
a safe, first-class tool SDK bound to Wrenyard's public MCP/IPC surfaces, plus
the **agent-scoped tool boundary** that keeps Wrenyard the sole orchestration
authority inside the harness.

## Architecture

- **DSH compatibility**: pinned to `@deepseek-ai/dsh@0.1.0-rc.6`. This package
  is a set of Cordis plugins (`name`, `inject: ['tools']`, `async apply(ctx)`)
  loaded through DSH's public plugin/profile bundle mechanism. **No DeepSeek
  source is vendored** and no internal/private provider is bundled.
- **Desktop profile composition**: the bundled desktop shell composes this
  plugin with DSH via `cordis.patch.yml` (short 啾啾工坊编排者 persona pointing
  at workspace `AGENTS.md`, `tools mode native`, `includeRuntimeContext: false`;
  not `complete: true`) and installs the `wrenyard` agent preset into
  `$DSH_HOME/.agent-presets/wrenyard`. DSH overwrites `agent-presets.roots`
  with its shipped standard/PTC/minimal/cordis directory, so a bundle cannot
  add a system roster root. Tool contracts live in workspace `AGENTS.md`, not
  in this harness.
- **Native presentation**: Desktop and the Wrenyard agent preset present DSH's
  native tools (`mode: native`), so the unrestricted `run_code` tool is never
  model-visible. Guarded native non-orchestration tools (bash, file read/write/
  edit, search, browser, jobs, goals, skills, ask-user) remain governed by the
  existing sandbox/approval policy. The tools bridge's `tools/pre-execute`
  listener only short-circuits the waterfall for its seven Wrenyard aliases
  (whose authority lives in the Wrenyard backend); native bash/fs/browser calls
  always continue through DSH's normal downstream approval/sandbox policy.
- **Agent-scoped boundary**: the preset loads
  `@wrenyard/dsh-shell/tool-boundary`, which reads the live tool catalog and
  calls `tools.restrict({ deny })` once for any present competing DSH
  orchestration tool (`subagent`, `subagent_fork`, `list_agents`,
  `send_message`, `interrupt_agent`, `workflow`, `ralph`, `ralph-loop`,
  `report`). It never names `run_code`, never allowlists legitimate tools, and
  fails loudly if `schemas()`/`restrict()`/`guard()` are unavailable. A scoped
  monotonic `tools.guard` also denies those orchestration names at execution
  time, closing the later-registration gap: even a competing orchestration tool
  registered after the catalog snapshot cannot execute. Legitimate
  non-orchestration tools are unaffected.
- **Seven Wrenyard aliases**: the bridge exposes three MCP task aliases and
  four owner-only IPC workspace-document aliases.
- **Public boundaries only**: everything goes through Wrenyard's public MCP
  (HTTP/SSE JSON-RPC) and owner-only NDJSON IPC. No Forge or Wrenyard
  implementation code is imported, and no credentials or raw environment values
  are ever logged.

## Model-visible tools

| Alias | Backend | Notes |
| --- | --- | --- |
| `list_task` | MCP `task_list` | Canonical MCP definition |
| `describe_task` | MCP `task_describe` | Canonical MCP definition |
| `run_task` | MCP `task_run` + IPC `task.run.wait` / `task.run.cancel` | Terminal wait with no implicit deadline; cancellation is owned and idempotent |
| `list_workspace_docs` | IPC `workspace.doc.list` | Optional `directory` string |
| `read_workspace_doc` | IPC `workspace.doc.read` | Requires `path` |
| `create_workspace_doc` | IPC `workspace.doc.create` | Requires `path` + `content` |
| `update_workspace_doc` | IPC `workspace.doc.update` | Requires `path` + `content` + `expectedContent` CAS |

The four workspace-doc aliases route unchanged params over the owner-only
NDJSON IPC socket only; there is no MCP fallback and no generic filesystem,
delete or rename surface. The daemon applies its workspace-root path
restriction and `expectedContent` compare-and-set validation. Backend IPC
errors surface as bounded rejections (`Wrenyard IPC error: ...`).

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
- MCP catalog missing a required task tool → startup fails with
  `Wrenyard: MCP catalog missing required task tool (...)`.
- Tool-boundary plugin without `tools.schemas()`/`tools.restrict()`/
  `tools.guard()` → fails rather than silently weakening the agent-scoped
  boundary.

`run_task` performs no status polling: it creates the backend task once, waits
over the owner-only IPC socket for the terminal envelope, and cancels the owned
backend task exactly once if the caller aborts.

## Test / pack

```sh
npm test            # node --test
npm run check       # same as test
npm run pack:check  # npm pack --dry-run
```

## License

MIT. Third-party notices for `@deepseek-ai/dsh` and Electron are preserved by
the suite; this package asserts no ownership of unverified assets.
