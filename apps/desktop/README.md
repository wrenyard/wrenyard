# @wrenyard/desktop

Hardened Electron desktop shell for the Wrenyard DSH.

> **Status: public development preview.** Target-qualified Desktop archives
> ship with Wrenyard development prereleases. They are suitable for testing,
> but remain preview artifacts: macOS builds are ad-hoc signed and Windows
> builds are unsigned until trusted platform signing is configured.

## Architecture

`@wrenyard/desktop` is the 啾啾工坊 product boundary. Its Electron main process
owns the application shell, notification-area integration and product settings,
while DSH remains an isolated child process and Pet runs as an internal module:

```
Electron product shell
  ├─ notification-area icon + product menu
  ├─ Activity Bar + Desktop-owned conversation/statistics/providers/settings pages
  ├─ bounded DSH HTTP/WebSocket adapter in the Electron main process
  ├─ Pet controller + in-process Pet runtime (overlay windows and observers)
  └─ spawns @deepseek-ai/dsh/lib/bin.js via ELECTRON_RUN_AS_NODE=1
       └─ loads the "web" profile (profiles/web under the DSH home)
            ├─ bundles: @deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, @wrenyard/dsh-shell
            ├─ last `--patch`: DSH_HOME/forge-model-patch.yaml (expanded public llm-pi-ai provider catalog)
            ├─ cwd + Host workspace registry pinned to Wrenyard `workspace.root`
            ├─ agent preset `wrenyard` at $DSH_HOME/.agent-presets/wrenyard (display name 啾啾工坊模式; hero dropdown disabled)
            └─ talks to Wrenyard through the public MCP/IPC contract
                 (@wrenyard/control-client — never Wrenyard internals)
```

- **Product navigation** — a 48px Wrenyard Activity Bar keeps a fixed,
  non-interactive Wrenyard brand mark at the top, exposes the Desktop-owned
  conversation surface as its own navigation item, adds “工房台账” and “模型供应”
  as top-level child functions and places “啾啾工坊设置” at the bottom. The single
  local renderer owns all four pages; no DSH Web UI or `WebContentsView` is
  embedded. `Cmd+,` / `Ctrl+,` opens settings; `Cmd+1` /
  `Ctrl+1` opens the workbench; `Cmd+2` / `Ctrl+2` opens statistics; `Cmd+3` /
  `Ctrl+3` opens Providers (模型供应).
- **Desktop-owned statistics** — Desktop reads the public `stats.summary`
  projection directly and falls back to `stats.today` for older/unavailable
  control planes. The full-width ledger receives a bounded view of today
  totals, completion rate, a 31-day heat map, Profile rows, Task rows and
  24h/7d/1mo windows. Pet only polls `stats.today` to enrich its passive house
  hover summary; it has no statistics window or action.
- **Desktop-owned quota & providers** — one Desktop controller runs the Runtime
  `quota --json` adapter on a bounded cache/refresh interval, applies the
  configured provider order once and projects the result to the notification-area
  “额度” submenu and the Pet house Tips; Pet no longer owns a quota poller and
  receives the latest provider projection as passive display data. The full-size
  quota page is now the Providers page (模型供应): it renders the unified
  provider/auth/quota directory, one row per runtime-supported provider, with
  identity, connection state, compact quota windows or monetary balances and a
  per-provider action. Unconfigured rows are visually de-emphasized while
  configuration stays reachable, and unknown/custom provider ids remain visible
  with safe generic copy. API-key entry covers the full supported Runtime
  public API provider set: the renderer sends the key through preload
  IPC and the Electron main process persists it by running the resolved suite
  Runtime binary with the key supplied on stdin only — keys never appear in
  argv, logs, snapshots or error text. After a successful write the DSH
  conversation session is rebuilt so launch-time credentials refresh, then the
  Provider/quota state is force-refreshed. Native-login providers open a
  guidance-only dialog instead of a fake key input, `deepseek` remains
  environment-variable-only, and no-auth rows are informational. Percentage
  windows retain remaining/expected values, while monetary providers retain
  their currency balances. Configured providers are grouped before unavailable
  providers. Provider order is one shared Settings SSOT and can be adjusted from
  either the Providers page or `设置 → 桌宠 → 额度来源`; tray and Pet enablement
  remains settings-only. The notification-area
  projection preserves the original grouped 5×7 RGBA template-bitmap renderer,
  including compact provider spacing, progress tracks, pace markers and balance
  columns; it is not replaced by native text labels or SVG menu images.
  LaunchServices startup resolves the Runtime from the active installed
  Wrenyard suite instead of relying on an inherited shell `PATH`.
- **Desktop-owned product settings** — the settings page reports public
  Wrenyard health, uptime, workspace root, IPC endpoint and suite/DSH versions;
  model credential presence moved to the Providers page. Workspace is a
  product-level fixed binding:
  `WRENYARD_DESKTOP_WORKSPACE` is an optional highest-priority override and is
  shown read-only in settings when present; otherwise Desktop reads and edits
  the user's `workspace.root` config. With neither source configured, the
  conversation page remains gated. There is no per-conversation workspace picker. It
  also owns the former Pet settings:
  companion appearance, scale, placement offset, bubble duration, entity
  visibility and quota-provider order. Desktop persists the bounded Pet config
  in its own settings store and applies it by restarting its in-process Pet
  runtime; Pet no longer creates a tray, settings window or settings action.
  Credential values are reduced to booleans in the main process and never sent
  to the renderer.
- **Desktop-owned updates** — settings exposes a quiet `stable` / `dev` channel
  selector, checks GitHub Releases shortly after startup and then every six
  hours, and keeps automatic failures silent. Only newer, complete target
  releases are offered. On macOS the main process downloads and stages only
  the Desktop archive, verifies its published SHA-256 checksum and the staged
  app signature, then asks the user before restarting. A separate packaged
  helper swaps the app and runs the public suite updater during restart as one
  recoverable operation; it restores the previous app when the suite update
  fails. Installation is blocked while Desktop conversations or Wrenyard tasks
  are active. Other platforms retain update discovery and channel selection
  until an equivalent native replacement flow is available.
- **Notification-area ownership** — Desktop owns the single three-wren macOS
  template icon and menu. It exists only while Desktop is active. The compact
  menu exposes only “打开”, “桌宠”, “额度” and “退出”; settings and statistics
  remain Desktop Activity Bar pages. Opening or dismissing the notification-area
  menu never changes the application window state; only the explicit “打开”
  command raises it. Companion enablement, display, visibility and reload stay
  consolidated under “桌宠”.
- **Lifecycle ownership** — Desktop starts and stops Pet in the same Electron
  main process. Foreman observes and executes agent work but exposes no Pet
  lifecycle RPC, config field or CLI command.

- **Single instance** — a second launch only focuses the existing window.
- **Window identity** — Pet overlays never suppress the macOS Dock identity of
  the Desktop host. Closing the product window hides it without ending the tray,
  DSH or Pet lifecycle; the Dock activation event and the tray “打开” command
  restore the same window.
- **Wrenyard and workspace gates** — Desktop probes
  `WrenyardIpcClient.health.ping()` on the resolved IPC socket (`WRENYARD_IPC_PATH`, legacy
  `FOREMAN_*` names, then the shared `wrenyard.sock` default). If no daemon is
  answering, the main process locates the installed Wrenyard CLI via
  `WRENYARD_CLI`, the working directory, or `~/.local/bin`, starts the service
  once (`wrenyard daemon start`), and retries health.ping with bounded retries.
  If the CLI cannot be found or never becomes ready, the product shell and its
  settings remain available while control-plane features report unavailable.
  A missing or invalid `workspace.root` prevents DSH from starting and places
  an explicit gate over conversations. The gate can open settings or save a
  valid directory directly; Desktop persists the path and replaces only the DSH
  conversation session in-process, so the new binding is usable without an App
  relaunch.
  LaunchServices provides no shell environment, so the
  CLI is located explicitly and the resolved connection context is passed to
  the DSH child directly. Wrenyard remains the sole state/permission owner.
- **DSH backend child** — started with launcher flags first
  (`--profile web --patch <overlay>`), then web flags
  (`--no-open --host 127.0.0.1 --port 0`). `--no-open` is the first web-app
  flag: `dsh-web-app` otherwise opens the default browser, which Desktop never
  wants because its own renderer talks to the loopback backend. `--patch` after `--host` is parsed as a
  web-app option, rejected, and the Desktop flash-quits. The Electron-as-node
  child must also receive `--expose-internals` *before* the DSH script path:
  `dsh-base` constructs `cordis-plugin-hmr` before `dsh-web-app` can disable
  it, and missing the flag exits the child with code 1 (same flash-quit). The overlay injects
  the expanded public Forge llm-pi-ai provider catalog without
  replacing native `deepseek-official` routes. Credential values are read from
  Wrenyard runtime `auth.json` and passed only as child env
  (`FORGE_DSH_*_API_KEY`); the patch file is secret-free. `DSH_HOME` points at
  an isolated profile. Child cwd and the Host workspace registry are pinned to
  Wrenyard `workspace.root` (`WRENYARD_DESKTOP_WORKSPACE` can override). The
  directory picker and DSH Web renderer are not product surfaces. Desktop uses
  the public unary API and mux/host event streams from the loopback child,
  filters sessions to the fixed workspace, and sends only a bounded
  conversation projection through preload IPC. The conversation header reads
  the selected session's advisory model directory through `session.models` and
  changes its next-request route through `session.selectModel`; models remain
  grouped by their DSH provider. The conversation model picker lists only
  providers whose credentials were actually passed to the DSH child — injected
  routes when their `FORGE_DSH_*_API_KEY` value is present, and the native
  `deepseek-official` route (mapped to the product id `deepseek`) only when
  `DEEPSEEK_API_KEY` is inherited. Unconfigured providers keep their setup rows
  on the Providers page (模型供应), so configuration stays reachable even though
  their models never appear in the picker. The header keeps the model picker unlabeled and
  shows only one Wrenyard daemon status lamp beside it; hovering or focusing the
  lamp refreshes public health and shows online state plus the start time derived
  from daemon uptime. The product projection exposes one canonical
  Kimi K3 route (the
  default route already has the 1M context window), collapses the Claude-oriented
  `k3[1m]` alias, and uses concise product labels such as `GLM 5.3` and
  `DeepSeek V4 Pro` while preserving DSH route ids; the native
  `deepseek-official` catalog also advertises the image-capable experimental
  `DeepSeek V4 Flash Vision` route. Desktop does not persist a
  parallel model preference. MCP defaults to
  `http://127.0.0.1:8787/mcp` so the Foreman tools bridge can reach the daemon
  under LaunchServices.
  Startup resolves only after the exact loopback URL line is parsed and
  `GET /` returns 2xx. Desktop owns the DSH child process tree and drains it
  synchronously on smoke completion, startup failure and application quit:
  SIGTERM to the process group, a bounded grace wait, then SIGKILL escalation
  (`taskkill /T /F` on Windows). No background DSH service is intentionally
  left running.
- **BrowserWindow hardening** — `contextIsolation: true`, `nodeIntegration:
  false`, `sandbox: true`, a bounded shell preload bridge, `window.open`
  denied, navigation away from the exact origin denied, all permission
  requests/checks denied. The renderer never receives the DSH loopback URL.
- **Failure surface** — DSH startup or child exit switches the conversation
  projection to an unavailable state while settings, statistics and quota remain
  usable; no raw environment values cross into the renderer.

## Isolated profile / state path

On each launch the main process prepares a DSH home under the per-user Electron
data directory (`app.getPath('userData')`):

```
<userData>/dsh/
  forge-model-patch.yaml              # secret-free public llm-pi-ai overlay
  profiles/web/
    node_modules/@wrenyard/dsh-shell/   # managed copy, replaced atomically each launch
    node_modules/@deepseek-ai -> ...    # link to packaged DSH runtime modules
    package.json                        # deterministic manifest with dsh.profile.bundles
    cordis.patch.yml                    # minimal managed overlay
```

Only the managed `@wrenyard/dsh-shell` bundle copy and managed DeepSeek module
link are replaced; unrelated profile content is preserved. When packaged, the shell sources come from
`process.resourcesPath/dsh-shell` (via `extraResources`); in development they
come from `packages/dsh-shell` in the monorepo.

## Security boundary

- The DSH web child binds loopback only (`127.0.0.1`); the URL parser rejects
  any non-loopback or malformed line (including DNS-rebinding style input).
- Wrenyard connection context (`WRENYARD_MCP_URL`, `WRENYARD_MCP_SENDER`,
  `WRENYARD_IPC_PATH`, with legacy `FOREMAN_*` fallbacks) is propagated to the
  child without ever being logged.
- The shell renderer has no Node access and receives only bounded settings,
  statistics, quota and conversation projections. Only the Electron main process
  talks to DSH; the renderer cannot open windows or navigate off-origin.
- The renderer never receives release download URLs, filesystem paths, tokens or
  updater process access. Update staging accepts only exact target asset names,
  checksum-matched archives and tightly scoped per-run cleanup directories.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run build` | typecheck + esbuild main bundle + type declarations |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | unit tests (profile, conversation projection + DSH child lifecycle, via tsx) |
| `npm run start` | run Electron against the current build |
| `npm run dev` | build then run Electron |
| `npm run smoke` | build then launch hidden Electron; exits 0 on load + health, non-zero on timeout |
| `npm run dist:dir` | unpacked Electron build into `release/` (Spotlight-hidden; `install-dev` then deletes the leftover `.app`) |
| `npm run dist:zip` | zip artifacts for the current platform (publish never) |

## Signing

Signing never embeds identities. Credential-free macOS builds receive a full
ad-hoc app-bundle signature in the `afterPack` hook and are verified before
zipping. Trusted releases rely on the standard environment hooks
(`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
`APPLE_TEAM_ID`) supplied at release time. Windows preview artifacts remain
unsigned unless a signtool identity is supplied; Linux uses checksums.

## Requirements

- Node.js `>=22.19.0`
- A Wrenyard daemon (the startup health gate starts it on demand via the
  installed CLI; see `tools/desktop/install-dev.mjs`)
- `npm install` at the monorepo root (workspace deps: `@wrenyard/control-client`,
  `@wrenyard/dsh-shell`, `@wrenyard/pet`; runtime:
  `@deepseek-ai/dsh@0.1.1-rc.2` pinned exactly)
