# @wrenyard/desktop

Hardened Electron desktop shell for the Wrenyard DSH.

> **Status: public development preview.** Target-qualified Desktop archives
> ship with Wrenyard development prereleases. They are suitable for testing,
> but remain preview artifacts: macOS builds are ad-hoc signed and Windows
> builds are unsigned until trusted platform signing is configured.

## Architecture

`@wrenyard/desktop` (Electron main process) hosts the DSH web application as an
isolated child process:

```
Electron main (dist/main.js)
  └─ spawns @deepseek-ai/dsh/lib/bin.js via ELECTRON_RUN_AS_NODE=1
       └─ loads the "web" profile (profiles/web under the DSH home)
            ├─ bundles: @deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, @wrenyard/dsh-shell
            ├─ last `--patch`: DSH_HOME/forge-model-patch.yaml (public kimi-coding / zhipu-coding)
            ├─ agent preset `wrenyard` at DSH_HOME/.agent-presets/wrenyard (模式 dropdown)
            └─ talks to Wrenyard through the public MCP/IPC contract
                 (@wrenyard/control-client — never Wrenyard internals)
```

- **Single instance** — a second launch only focuses the existing window.
- **Wrenyard gate** — before DSH starts, `WrenyardIpcClient.health.ping()` must
  succeed on the resolved IPC socket (`WRENYARD_IPC_PATH`, legacy
  `FOREMAN_*` names, then the shared `wrenyard.sock` default). If no daemon is
  answering, the main process locates the installed Wrenyard CLI via
  `WRENYARD_CLI`, the working directory, or `~/.local/bin`, starts the service
  once (`wrenyard daemon start`), and retries health.ping with bounded retries.
  If the CLI cannot be found or never becomes ready, the app exits loudly with
  a visible diagnostic. LaunchServices provides no shell environment, so the
  CLI is located explicitly and the resolved connection context is passed to
  the DSH child directly. Wrenyard remains the sole state/permission owner.
- **DSH web child** — started with launcher flags first
  (`--profile web --patch <overlay>`), then web flags
  (`--host 127.0.0.1 --port 0`). `--patch` after `--host` is parsed as a
  web-app option, rejected, and the Desktop flash-quits. The overlay injects
  the public Forge llm-pi-ai catalog (`kimi-coding` / `zhipu-coding`) without
  replacing native `deepseek-official` routes. Credential values are read from
  Wrenyard runtime `auth.json` and passed only as child env
  (`FORGE_DSH_*_API_KEY`); the patch file is secret-free. `DSH_HOME` points at
  an isolated profile, cwd at the requested workspace. MCP defaults to
  `http://127.0.0.1:8787/mcp` so the Foreman tools bridge can reach the daemon
  under LaunchServices.
  Startup resolves only after the exact loopback URL line is parsed and
  `GET /` returns 2xx. Desktop owns the DSH child process tree and drains it
  synchronously on smoke completion, startup failure and application quit:
  SIGTERM to the process group, a bounded grace wait, then SIGKILL escalation
  (`taskkill /T /F` on Windows). No background DSH service is intentionally
  left running.
- **BrowserWindow hardening** — `contextIsolation: true`, `nodeIntegration:
  false`, `sandbox: true`, no preload, `window.open` denied, navigation away
  from the exact origin denied, all permission requests/checks denied, window
  shown only after `ready-to-show`.
- **Failure surface** — DSH child exit renders a local `data:text` error page
  with no raw environment values.

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
- The renderer has no Node access, no preload bridge, and cannot open windows
  or navigate off-origin.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run build` | typecheck + esbuild main bundle + type declarations |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | unit tests (profile + DSH child lifecycle, via tsx) |
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
  `@wrenyard/dsh-shell`; runtime: `@deepseek-ai/dsh@0.1.0-rc.6` pinned exactly)
