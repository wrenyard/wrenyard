# Development guide

## Setup

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

The repository pins Node.js `>=24.19.0` and pnpm `11.19.0`. The install runs
Electron's native setup script (`allowBuilds.electron` in
`pnpm-workspace.yaml`); do not skip it, or Desktop cannot start. SQLite uses
`better-sqlite3` Node-API prebuilds, so supported x64/arm64 hosts need no
Python or C++ toolchain.

## The dev loop

`pnpm dev` runs the daemon and Desktop dev scripts in parallel. Start one side
alone with `pnpm --filter @wrenyard/daemon dev` or
`pnpm --filter @wrenyard/desktop dev`.

- **Daemon** (`apps/daemon/scripts/dev.ts`) refuses to start if a daemon already
  answers on the IPC path. Otherwise it runs the daemon through tsx, watches
  `apps/daemon/**` and `packages/**`, type-checks after a change, waits until
  the daemon is idle and restarts it gracefully. A clean daemon exit is
  relaunched. `Ctrl+C` drains; a second `Ctrl+C` forces.
- **Desktop** runs `electron-vite dev --watch`: the renderer hot-reloads with
  React Refresh, preload changes reload every window and main-process changes
  restart the app. A source Desktop never launches a daemon; it shows the daemon
  as unavailable and reconnects when one with the same product version appears.
  The title bar shows a 开发模式 badge while running from source.

After a manifest or lockfile change, stop the dev scripts, run
`pnpm install --frozen-lockfile` and start them again.

## Shared data

Source development and an installed app share the same user configuration and
daemon state under `~/.config/wrenyard` and `~/.local/state/wrenyard`. On Linux
the Desktop `userData` directory is always `<state root>/desktop`, matching the
daemon. Other platforms keep Electron's default unless you set
`WRENYARD_STATE_HOME` or `WRENYARD_DESKTOP_USER_DATA`. Quit the installed app
fully from the menu bar or tray before `pnpm dev`; closing the window is not
enough.

## Checks

```sh
pnpm lint    # oxlint + tsc (the only CI quality gate)
pnpm test    # tool tests + package tests
pnpm check   # public identifiers, secrets, legal, version consistency
```

## DSH compatibility

The DSH client adapter (`packages/clients/dsh`) drives an externally installed
`@deepseek-ai/dsh`; the harness is not bundled with the suite. The adapter
enforces a minimum supported executable version of `0.2.0-rc.2` and refuses to
launch anything older, so a legacy `0.1.x` runtime is no longer supported. The
legacy stream parser still decodes old event shapes cheaply, but it does not
make an old DSH runtime runnable. Upgrade a global install with:

```sh
npm install -g @deepseek-ai/dsh@0.2.0-rc.2
```

Set `WRENYARD_DSH_BIN` to point the adapter at a local or prefix install
instead of the `dsh` found on `PATH`. Native session resume stays disabled:
every run uses a disposable per-run `DSH_HOME` and keeps no persistent session
store. On the native route the canonical `deepseek` provider maps to upstream
`deepseek-official`, and the flash aliases `deepseek-v4-flash` and
`deepseek-v4.1-flash` resolve to upstream `deepseek-flash`.

## Screenshots and the product tour

`apps/desktop/tools/showcase/` renders the built Desktop renderer against
fictional, deterministic demo data — sessions, models, quota, statistics, bots
and routines — and drives scripted scenarios. No daemon, workspace or account
is involved, so every capture is free of personal data.

```sh
pnpm build
pnpm --filter @wrenyard/desktop exec electron tools/showcase/run.mjs \
  --scenario tools/showcase/scenarios/screenshots.mjs --out .showcase --scale 2
```

`scenarios/screenshots.mjs` writes the README and guide images with the same
names as `docs/images/`; copy them over after review. `scenarios/promo.mjs`
records short clips (with `ffmpeg` on `PATH`) for release notes and demos; the
recordings are not kept in the repository.

The demo bridges implement the same `WrenyardShellApi` and session bridge as
the real preload, and the demo ledgers use the real ledger event types. When a
shell method or ledger event changes, update `demo-shell.ts` and
`demo-session.ts` with it so the tour keeps rendering.

## Releases

Versions live in the root `package.json` (mirrored in
`apps/desktop/package.json`). `pnpm release <x.y.z>` accepts a plain version
(no prerelease), writes it, packs and smoke-tests this platform's installer, and
commits `release: <x.y.z>`. Pushing a `v*.*.*` tag runs
`.github/workflows/release.yml`, which lints, builds macOS, Windows and Linux
installers and publishes a normal release together with the update feed on the
`updates` branch. The feed head is `latest.json`; a byte-identical `dev.json`
compatibility alias and the immutable `versions/<v>.json` snapshots are
published alongside it. See [release/signing.md](release/signing.md) for the
signing status.
