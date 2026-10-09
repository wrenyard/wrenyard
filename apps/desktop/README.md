# @wrenyard/desktop

Electron product shell for Wrenyard daemon features.

> **Status: public development preview.** Target-qualified Desktop archives
> ship with Wrenyard development prereleases. They are suitable for testing,
> but remain preview artifacts: macOS builds are ad-hoc signed and Windows
> builds are unsigned until trusted platform signing is configured.

## Architecture

`@wrenyard/desktop` is the 啾啾工坊 product boundary. Its Electron main process
owns the application shell, notification-area integration and product settings,
while sessions run in the daemon-owned session feature and Pet remains an internal Desktop module:

```
Desktop renderer + preload + Electron main
  |-- window, tray, product settings, Pet
  `-- session bridge -> session IPC -> daemon session feature (@wrenyard/session)
```

- **Product navigation** — a 48px Wrenyard Activity Bar keeps a fixed,
  non-interactive Wrenyard brand mark at the top, exposes the session page as
  its own navigation item, adds “工房台账” and “模型供应”
  as top-level child functions and places “啾啾工坊设置” at the bottom. The single
  local renderer owns every page; no embedded web UI or `WebContentsView` is
  used. `Cmd+,` / `Ctrl+,` opens settings; `Cmd+1` /
  `Ctrl+1` opens the session; `Cmd+2` / `Ctrl+2` opens statistics; `Cmd+3` /
  `Ctrl+3` opens Providers (模型供应).
- **Desktop-owned statistics** — Desktop reads the public `stats.summary`
  projection directly; there is no `stats.today` fallback. The full-width ledger
  receives a bounded view of today totals, completion rate, a 31-day heat map
  and 24h/7d/1mo windows, which are the single authoritative source for Profile
  and Task rankings. Pet only polls `stats.today` to enrich its passive house
  hover summary; it has no statistics window or action.
- **Desktop-owned quota & providers** — one Desktop controller runs the Runtime
  `quota --json` adapter on a bounded cache/refresh interval, applies the
  configured provider order once and projects the result to the notification-area
  “额度” submenu and the Pet house Tips; Pet no longer owns a quota poller and
  receives the latest provider projection as passive display data. The full-size
  quota page is now the Providers page (模型供应): it renders the unified
  provider/auth/quota directory, one row per runtime-supported provider, with
  identity, connection state, compact quota windows or monetary balances and a
  per-provider action. Unconfigured rows stay visually de-emphasized, expose
  only their activation action and never enter dispatch/model/quota surfaces;
  unknown/custom provider ids remain visible
  with safe generic copy. API-key entry covers the full supported Runtime
  public API provider set: the renderer sends the key through preload
  IPC and the Electron main process persists it by running the resolved suite
  Runtime binary with the key supplied on stdin only — keys never appear in
  argv, logs, snapshots or error text. After a successful write the
  Provider/quota state is force-refreshed; the session backend reads changed
  credentials itself on its next call. Native-login providers open a
  guidance-only dialog instead of a fake key input, `deepseek` remains
  environment-variable-only, and no-auth rows are informational. Percentage
  windows retain remaining/expected values, while monetary providers retain
  their currency balances. Configured providers are grouped before unavailable
  providers. The Providers page is the only ordering/configuration surface;
  its persisted order also controls the filtered quota subset used by the tray
  and Pet. The legacy provider `enabled` bit remains wire-compatible but has no
  product behavior. The notification-area
  projection preserves the original grouped 5×7 RGBA template-bitmap renderer,
  including compact provider spacing, progress tracks, pace markers and balance
  columns; it is not replaced by native text labels or SVG menu images.
  LaunchServices startup resolves the Runtime from the active installed
  Wrenyard suite instead of relying on an inherited shell `PATH`.
- **Desktop-owned product settings** — the settings page reports public
  Wrenyard health, uptime, workspace root and IPC endpoint;
  model credential presence moved to the Providers page. Workspace is a
  product-level fixed binding:
  `WRENYARD_WORKSPACE` is an optional highest-priority override and is
  shown read-only in settings when present; otherwise Desktop reads and edits
  the user's `workspace.root` config. Saving a workspace writes the config and
  restarts the daemon, which then binds the new root at startup; there is no
  per-session workspace picker and no blocking workspace gate. It
  also owns the former Pet settings:
  companion appearance, scale, placement offset, bubble duration, entity
  visibility and quota-provider order. Desktop persists them in one partitioned
  `DesktopSettingsStore` document; visibility is applied in place, and only a
  structural change (scale, skin, display) rebuilds the in-process Pet runtime.
  Pet no longer creates a tray, settings window, settings action or config file,
  and older documents are converted once by `tools/convert-settings.mjs`
  instead of being migrated at startup.
  Credential values are reduced to booleans in the main process and never sent
  to the renderer.
- **Desktop-owned updater** — Desktop checks the update feed shortly after
  startup and then at most once per hour; manual checks are not rate limited.
  Help → Check for Updates opens a native popup for current, available, waiting
  and installing states. After the user confirms, Desktop waits for
  `daemon.status.idle`, downloads the platform update asset and verifies its
  SHA-256 against the feed, writes `update-pending.json`, and applies it with a
  platform applier (`setup.exe /S` on Windows, a verified zip swap on macOS)
  before quitting. The first version does not roll back; a failed or interrupted
  update is reported on the next launch.
- **Notification-area ownership** — Desktop owns the single three-wren macOS
  template icon and menu. It exists only while Desktop is active. The compact
  menu exposes only “打开”, “桌宠”, “额度” and “退出”; settings and statistics
  remain Desktop Activity Bar pages. Opening or dismissing the notification-area
  menu never changes the application window state; only the explicit “打开”
  command raises it. Companion enablement, display, visibility and reload stay
  consolidated under “桌宠”.
- **Lifecycle ownership** — Desktop starts and stops Pet in the same Electron
  main process. The daemon observes and executes agent work but exposes no Pet
  lifecycle RPC, config field or CLI command.

- **Single instance** — a second launch only focuses the existing window.
- **Window identity** — Pet overlays never suppress the macOS Dock identity of
  the Desktop host. Closing the product window hides it to the tray without
  ending the tray, session backend or Pet lifecycle on every platform; only the tray “退出”
  command quits. The Dock activation event and the tray “打开” command restore
  the same window.
- **Wrenyard and workspace gates** — Desktop probes
  `WrenyardIpcClient.health.ping()` on the resolved IPC socket
  (`WRENYARD_IPC_PATH`, then `\\.\pipe\wrenyard` on Windows or
  `/tmp/wrenyard.sock` on Unix). Blank environment values are ignored.
  Only a packaged Desktop
  (`app.isPackaged`) launches the daemon bundle when none is running at startup,
  as a child of its own process running
  `<resources>/wrenyard/runtime/node <resources>/wrenyard/daemon/daemon.mjs run --config <path>`,
  then retries `health.ping`. A source Desktop never launches a daemon: it only
  connects and waits until one is available, and reconnects automatically when a
  daemon with the same product version appears. Ownership is decided once at
  startup and stays fixed; a daemon whose product version differs from the
  Desktop version is rejected and never replaced. It restarts an unexpectedly
  exited daemon (1s/5s/15s, at most 3 times in 5 minutes) and, on a clean exit,
  shows “daemon stopped” with a restart action; a failed start shows its reason.
  A missing or invalid `workspace.root` prevents the session backend from
  starting. Saving a valid directory writes the config and restarts the daemon,
  which binds the new workspace at startup without an App relaunch; there is no
  blocking gate dialog. Wrenyard remains the sole state/permission owner.
- **Session ownership** — the daemon's session feature owns the context-ledger
  sessions, session history, summary preference, task ownership and recovery.
  Desktop receives versioned product snapshots over IPC. Closing Desktop
  detaches the view; daemon shutdown releases the backend. See
  [session feature](../../packages/features/session/README.md).
- **BrowserWindow hardening** — `contextIsolation: true`, `nodeIntegration:
  false`, `sandbox: true`, a bounded shell preload bridge, `window.open`
  denied, navigation away from the exact origin denied, all permission
  requests/checks denied.
- **Failure surface** — session backend failure switches the session projection
  to an unavailable state while settings, statistics and quota remain
  usable; no raw environment values cross into the renderer.

## User interface

Desktop is one Electron window with a persistent frame:

- **Title bar** — back/forward navigation, the current page title and the
  window controls.
- **Activity rail** — a fixed vertical rail with the primary pages
  (会话, 工房台账, 模型供应, 任务) and settings in its footer.
- **Status bar** — a compact bar that projects live daemon, activity and quota
  state.
- **Themes** — the built-in paper and neutral themes, each with light and dark
  modes.
- **Pet** — an in-process companion rendered in the same Electron main process;
  it owns only passive overlays and has no settings window or statistics page.

## Security boundary

- Wrenyard connection context (`WRENYARD_IPC_PATH`) is propagated to the daemon
  without ever being logged. The daemon
  has no MCP or HTTP client surface; the gateway that serves its own agents
  binds a random loopback port with an in-memory token.
- The shell renderer has no Node access and receives only bounded settings,
  statistics, quota and session projections; the renderer cannot open windows or
  navigate off-origin.
- The renderer never receives release download URLs, filesystem paths, tokens or
  updater process access. Update checks receive only version and asset metadata;
  the renderer never downloads, stages or swaps files.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm --filter @wrenyard/desktop run build` | build the Desktop bundle (`dist/`) |
| `pnpm --filter @wrenyard/desktop test` | Desktop shell tests (session engine tests live in packages/features/session/test) |

From the repository root: `pnpm --filter @wrenyard/desktop dev` runs
`electron-vite dev --watch` (renderer HMR with React Refresh, preload changes
reload all windows, main-process changes restart Desktop). The production build
is `pnpm --filter @wrenyard/desktop run build` (`electron-vite build`), which
produces `dist/main/index.js`, `dist/preload/<id>.cjs` and `dist/web/**`.
`pnpm lint` and `pnpm check` run the repository gates, and
`pnpm release <x.y.z>` packs this platform's installer.

## Signing

Signing never embeds identities. Credential-free macOS builds receive a full
ad-hoc app-bundle signature in the `afterPack` hook and are verified before
zipping. Trusted releases rely on the standard environment hooks
(`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
`APPLE_TEAM_ID`) supplied at release time. Windows preview artifacts remain
unsigned unless a signtool identity is supplied.

## Requirements

- Node.js `>=24.19.0` for source development (the packaged app ships its own
  Node runtime)
- A Wrenyard daemon. Desktop connects to one that is already running, or
  supervises one itself with the packaged runtime (`wrenyard daemon run`).
- `pnpm install` at the monorepo root. Desktop consumes the control client and
  product protocol; the daemon's session feature owns the pinned session runtime.
