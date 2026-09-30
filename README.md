# Wrenyard

[![CI](https://github.com/wrenyard/wrenyard/actions/workflows/ci.yml/badge.svg)](https://github.com/wrenyard/wrenyard/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/wrenyard/wrenyard?include_prereleases&label=latest-dev)](https://github.com/wrenyard/wrenyard/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Wrenyard is a development-preview product that unifies task orchestration, a
native agent execution, and a desktop observer under one command surface:
**`wrenyard`**.

> **Status: development preview.** Distributed as Desktop installers from the
> rolling latest-dev channel and installable from source, but not a supported
> stable release. See [Status](#status).

## What it is

- **`apps/cli`** — the thin `wrenyard` command surface for developers and
  agents. It talks to the daemon over the owner-only local IPC surface, never
  starts the daemon itself, and reports a single message when no daemon is
  running.
- **`apps/daemon`** — the TypeScript control plane that schedules and tracks
  task graph work. Its only external interface is the owner-only NDJSON IPC
  surface, and its one run entry point is `wrenyard daemon run`.
- **packages/features** — product features, including execution, providers, quota and routing.
- **packages/clients** — native client arguments, account reads and event normalization.
- **packages/execution** — subprocess, stdio RPC, SQLite and keychain primitives.
- **`apps/pet`** — the headless Desktop companion renderer. It reads current
  activity from the control plane and owns only passive companion overlays;
  it has no tray, settings, statistics page or hover action buttons.
- **`apps/desktop`** — the 啾啾工坊 product shell, the primary product surface.
  It owns the application window, notification-area icon/menu, custom
  conversation UI, statistics, quota and settings, uses DSH as its conversation
  backend, manages Pet as a child component, supervises the daemon while it
  runs, and applies its own updates.
- **`packages/dsh-shell`** — the dsh profile/bundle shell reused by the
  desktop host.

Wrenyard is one product in one monorepo. `wrenyard` is the only public command
surface; there are no legacy public compatibility commands. The product is
local-first: the daemon serves only owner-only local IPC, and the gateway it
runs for its own agents binds a random loopback port with an in-memory token.

## Repository layout

```
apps/          applications (Desktop shell, unified CLI, daemon control plane, observer)
packages/      features, clients, execution, protocol and shared definitions
contracts/     cross-component schemas and version index
tools/         developer tooling, checks, and release scripts
docs/          architecture, migration, and signing notes
```

## Targets

Public releases are maintained for Apple Silicon macOS (`darwin-arm64`) and
64-bit Windows (`win32-x64`). Wrenyard ships Desktop installers only; each
release publishes three artifacts:

| Platform | Artifact | Purpose |
| --- | --- | --- |
| `win32-x64` | `wrenyard-desktop-<version>-win32-x64-setup.exe` | first install and in-app update |
| `darwin-arm64` | `wrenyard-desktop-<version>-darwin-arm64.dmg` | first install |
| `darwin-arm64` | `wrenyard-desktop-<version>-darwin-arm64.zip` | in-app update |

There is no suite archive and no one-click install script. Download the
artifact for your platform from the GitHub release.

## Prerequisites

- Node.js 24.19 or newer
- pnpm 11.19.0 (frozen via the repository lockfile)
## Develop from source

After a clone, from the repository root (not an installed suite):

```powershell
cd D:\GitHub\wrenyard
pnpm install --frozen-lockfile
pnpm build
pnpm dev
```

macOS uses the same last three commands; only the checkout path changes.
Toolchain versions come from the root `package.json` and lockfile (Node >=24.19.0, pnpm 11.19.0). The install
is allowed to run the Electron native build script (`pnpm-workspace.yaml`
`allowBuilds.electron`). Do not skip that: an install that leaves Electron
missing cannot start Desktop.

SQLite uses better-sqlite3 13 Node-API prebuilds shipped with the package; its
implicit node-gyp build is disabled, so supported x64/arm64 hosts do not need
Python or a C++ toolchain. After updating dependencies, run `pnpm install` and
restart `pnpm dev` once to load the pinned Node 24 runtime.

`pnpm build` builds only the Desktop bundle. The CLI and daemon run from source
through tsx, so no per-package `dist/` is produced and nothing is installed or
started.

Daily loop, still from the checkout root:

```powershell
# Runs the daemon and Desktop dev scripts in parallel. Keep this terminal running.
pnpm dev           # daemon + Desktop dev scripts, in parallel
```

`pnpm dev` runs `pnpm --parallel --filter @wrenyard/daemon --filter @wrenyard/desktop run dev`: both dev scripts start in parallel with no orchestration, so their start order does not matter. Run one side alone with `pnpm --filter @wrenyard/daemon dev` or `pnpm --filter @wrenyard/desktop dev`.

`pnpm --filter @wrenyard/daemon dev` runs `apps/daemon/scripts/dev.ts`. It refuses to start if a daemon already answers on the IPC path; otherwise it runs `lib/main.mts run` through tsx with the default config, watches `apps/daemon/**` and `packages/**`, and after a content change type-checks the daemon, waits for `daemon.status` idle, then gracefully restarts it. A clean daemon exit (for example a workspace switch from a source Desktop) is relaunched. Ctrl+C drains and stops it; a second Ctrl+C forces.

`pnpm --filter @wrenyard/desktop dev` runs `electron-vite dev --watch`: the renderer updates through Vite with React Refresh, preload changes reload every window, and main-process changes restart Desktop. A source Desktop never launches a daemon; it shows the daemon as unavailable and reconnects automatically when a daemon with the same product version appears.

Source-development and an installed Desktop share the same user config,
state, Desktop `userData`, and DSH session location. The Desktop `userData`
directory is keyed to the installed package identity `@wrenyard/desktop`
(Electron's default for that package), not to the localized **啾啾工坊**
display name, so source-development reuses the settings and DSH session an
installed Desktop already wrote. There is no migration or copy, and your
existing files are left untouched; set `WRENYARD_DESKTOP_USER_DATA` to point
source-development at a different directory, and only one Wrenyard instance may
use that data domain at a time. Because the daemon dev script refuses to start next to a running daemon, quit 啾啾工坊 fully from the tray (or run `wrenyard daemon stop`) before starting it. Closing the window is not enough.

Manifest or lockfile changes: stop the dev scripts and run
`pnpm install --frozen-lockfile`, then start them again. Install/build
errors remain visible and the watcher waits for the next save; no release
installer is involved. Unexpected component exits are reported without an
automatic crash-restart loop. Save a source file or start `pnpm dev`
again to retry.

## Install

Wrenyard ships only as a Desktop application. Each release publishes three
artifacts on the GitHub releases page (see [Targets](#targets)); there is no
suite archive, no SEA install engine and no one-click bootstrap script.

1. Download the artifact for your platform:
   - Windows: `wrenyard-desktop-<version>-win32-x64-setup.exe`
   - macOS: `wrenyard-desktop-<version>-darwin-arm64.dmg`
2. Run it. The packaged app carries the single-file CLI, a Node runtime and the
   daemon bundle (`daemon/daemon.mjs` with only its native and DSH runtime
   dependencies) under its Resources, so nothing else is required.

**First launch is blocked by the OS** because preview builds are ad-hoc signed
on macOS and unsigned on Windows:

- **macOS** — Gatekeeper blocks the app; open **System Settings → Privacy &
  Security** and choose **Open Anyway**. On macOS 15, right-click → Open no
  longer works.
- **Windows** — SmartScreen shows “Windows protected your PC”; choose **More
  info → Run anyway**.

After that, in-app updates run normally and are not blocked.

### Updating

啾啾工坊 updates itself. It reads the update feed published on the `updates`
branch, downloads the new artifact, verifies its SHA-256, and applies it with
its in-app updater (`setup.exe /S` on Windows, a verified zip swap on macOS).
The app must be fully quit from the tray for an update to apply. The first
version does not roll back a failed update.

### Command-line-only installs

Without Desktop there is no installer. Install the CLI from source:

```sh
git clone https://github.com/wrenyard/wrenyard.git
cd wrenyard
pnpm install --frozen-lockfile
pnpm setup                 # once, if pnpm's global bin directory is not on PATH
pnpm link --global         # exposes `wrenyard`
```

The linked CLI runs the daemon in the foreground with `wrenyard daemon run`; it
never starts a background daemon. On Windows the Desktop installer can
optionally add the bundled CLI directory to `PATH` from its “Add to PATH”
checkbox (unchecked by default). macOS offers no PATH configuration; create a
link to `/Applications/啾啾工坊.app/Contents/Resources/wrenyard/wrenyard`
yourself if needed.

### Upgrading from a release with external client configuration

Earlier preview releases could point your own Claude Code, Codex, Grok Build or
Claude App configuration at the Wrenyard gateway from the Desktop “客户端”
(Clients) page. That feature is removed, and there is no automatic restoration.

- **Before upgrading,** open the old Desktop, go to the Clients page and click
  **Restore** for each configured client.
- **If you already upgraded,** the page is gone. Manually remove the base URL
  and credential-helper entries Wrenyard wrote from each affected tool's
  configuration so it stops pointing at `127.0.0.1:8787/gateway/...`.

Preview binaries are signed ad-hoc on macOS and unsigned by default on Windows
(see [Signing (honest)](#signing-honest)).

## Command surface

- `wrenyard` — print help and enter the unified command surface
- `wrenyard desktop` — launch the 啾啾工坊 Desktop application
- `wrenyard daemon run` — run the control plane in the foreground (first Ctrl+C drains active work, a second forces shutdown)
- `wrenyard daemon stop` — ask a running daemon to shut down (`--force` skips draining)
- `wrenyard daemon status` — report daemon health from IPC and the daemon lock
- `wrenyard doctor` — check the local install and report problems
- `wrenyard task` — delegate and track bounded project work
- `wrenyard exec` / `wrenyard quota` / `wrenyard project` / `wrenyard taskgraph` — exec, provider quota, project and task-graph commands (`--json` on all of them)

The daemon has a single run entry point, `wrenyard daemon run`; Desktop and the
terminal use it, and the daemon dev script runs it through tsx. The CLI never
starts or restarts the daemon. When no daemon is reachable it reports one
message: the Wrenyard daemon is not running — open 啾啾工坊, or run
`wrenyard daemon run` in a terminal.

## Builtin tasks

Seven reusable roles share the same task runtime and automatic cost, speed,
and capability selection:

| Task | Work to delegate |
| --- | --- |
| `explore` | Investigate code, Git history, notes, logs, and concrete failures |
| `edit` | Implement bounded file changes, including fixes and test code |
| `test` | Run verification and report evidence |
| `code-review` | Review correctness and conformance to supplied requirements |
| `commit` | Commit the declared changes locally |
| `librarian` | Research external documentation and sources |
| `oracle` | Analyze difficult technical questions and tradeoffs |

Use `wrenyard task list` and `wrenyard task describe <id>` for current contracts.
Choose roles as needed; no FP/FU/IU pipeline or staged debugging workflow is
required. Retired roles (including the old `implement` and `look-at` builtins)
are removed rather than hidden behind aliases. Existing run records remain
readable; restarting work that names a retired task requires a current role.
Project-authored tasks remain available.

## Uninstall

Uninstall 啾啾工坊 the normal way for your platform — remove the app from
`/Applications` on macOS, or use “Apps & features”/the NSIS uninstaller on
Windows. The uninstaller also removes the optional PATH entry on Windows. User
configuration and state directories live outside the install location and are
never touched. A CLI-only install is removed with
`pnpm uninstall --global wrenyard`.

The first updater version does not roll back a failed update; it reports the
failure and points you at the release page for a manual download.

## Building from source

```sh
pnpm install
pnpm build
pnpm test
```

`pnpm build` builds only the Desktop bundle; the CLI and daemon run from source
through tsx (the source CLI is `pnpm wrenyard ...`). Other root scripts:
`pnpm lint` (oxlint + `tsc`), `pnpm check`
(release gates: public identifiers, secrets, legal, version consistency) and
`pnpm test`. These checks are run through the workspace Tasks and repository
instructions, not by GitHub Actions. All root scripts (`build`, `dev`,
`release`, `lint`, `check`, `test`, `wrenyard`) are defined only
at the repository root; internal packages keep no `build` or `typecheck`
script.

Local release:

```sh
pnpm release <x.y.z>    # write the version, pack this platform's installer, commit
```

`pnpm release <x.y.z>` writes the version to the root and Desktop manifests,
runs `node tools/release/pack.mjs` to build this platform's installer and smoke
the assembled app, then commits `release: <x.y.z>`; a same-version argument
repacks without committing. The tag is created and pushed manually. A
`v*-dev.*` tag triggers `release.yml`: a build job on `macos-15` and
`windows-latest` produces each platform's artifacts, and a publish job verifies
the tag, confirms all three artifacts are present, publishes a prerelease, and
pushes the update feed (`dev.json` and `versions/<version>.json`) to the
`updates` branch. A manual workflow dispatch is build-only and never creates a
tag, release, or feed.

## Signing (honest)

Preview builds are signed ad-hoc on macOS and unsigned by default on Windows.
Ad-hoc signing proves integrity and buildability, not publisher identity.
Trusted release signing is future work and never runs in this repository. See
[docs/release/signing.md](docs/release/signing.md).

## Status

This repository publishes rolling `1.0.0-dev.N` development prereleases.
Nothing is published to npm, and no stable release exists. Remaining before a
stable release:

- Final trusted code signing of the desktop app and platform payloads
- Wider clean-machine testing and a documented compatibility policy

Licensing: MIT (see `LICENSE`). Third-party notices and asset provenance are
preserved and verified via `pnpm check`.

## Documentation

- [Architecture](docs/architecture.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [Migration history](docs/migration/README.md)
- [Changelog](CHANGELOG.md)
