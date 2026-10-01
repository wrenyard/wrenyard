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

Source development and an installed app share the same user configuration,
state and Desktop `userData` directory (keyed to the package identity
`@wrenyard/desktop`). Quit the installed app fully from the menu bar or tray
before `pnpm dev`; closing the window is not enough. Set
`WRENYARD_DESKTOP_USER_DATA` to give source development its own Desktop data
directory.

## Checks

```sh
pnpm lint    # oxlint + tsc (the only CI quality gate)
pnpm test    # tool tests + package tests
pnpm check   # public identifiers, secrets, legal, version consistency
```

## Screenshots and the product tour

`apps/desktop/tools/showcase/` renders the built Desktop renderer against
fictional demo data and drives scripted scenarios:

```sh
pnpm build
pnpm --filter @wrenyard/desktop exec electron tools/showcase/run.mjs \
  --scenario tools/showcase/scenarios/screenshots.mjs --out .showcase --scale 2
```

`scenarios/promo.mjs` records the clips used for the product tour video.

## Releases

Versions live in the root `package.json` (mirrored in
`apps/desktop/package.json`). `pnpm release <x.y.z>` writes the version, packs
and smoke-tests this platform's installer, and commits `release: <x.y.z>`.
Pushing a `v*-dev.*` tag runs `.github/workflows/release.yml`, which lints,
builds macOS and Windows installers and publishes a prerelease together with
the update feed on the `updates` branch. See
[release/signing.md](release/signing.md) for the signing status.
