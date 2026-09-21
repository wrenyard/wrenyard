# Wrenyard

[![CI](https://github.com/wrenyard/wrenyard/actions/workflows/ci.yml/badge.svg)](https://github.com/wrenyard/wrenyard/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/wrenyard/wrenyard?include_prereleases&label=latest-dev)](https://github.com/wrenyard/wrenyard/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Wrenyard is a development-preview product that unifies task orchestration, a
precompiled Go runtime, and a desktop observer under one command surface:
**`wrenyard`**.

> **Status: development preview.** Installable from source and from the
> rolling latest-dev channel, but not a supported stable release. See
> [Status](#status).

## What it is

- **`apps/cli`** — the unified `wrenyard` command surface. The canonical entry
  point, also shipped as a standalone single-file Node SEA executable.
- **`services/foreman`** — the TypeScript control plane that schedules and
  tracks task graph work.
- **`runtime/forge`** — the Go runtime that executes agent work and streams
  activity, shipped as precompiled per-platform packages.
- **`apps/pet`** — the headless Desktop companion renderer. It reads current
  activity from the control plane and owns only passive companion overlays;
  it has no tray, settings, statistics page or hover action buttons.
- **`apps/desktop`** — the 啾啾工坊 product shell. It owns the application
  window, notification-area icon/menu, custom conversation UI, statistics,
  quota and settings, uses DSH as its conversation backend, and manages Pet as a child
  component.
- **`packages/dsh-shell`** — the dsh profile/bundle shell reused by the
  desktop host.
- **`packages/runtime-*`** — auditable staging manifests for the CI-built
  precompiled Forge runtime payloads.

Wrenyard is one product in one monorepo. `wrenyard` is the only public command
surface; there are no legacy public compatibility commands.

## Repository layout

```
apps/          applications (unified CLI, desktop DSH shell, observer)
services/      control-plane services
runtime/       Go runtime components
packages/      shared packages and per-platform runtime staging
contracts/     cross-component schemas and version index
tools/         developer tooling, checks, and release scripts
docs/          architecture, migration, and signing notes
```

## Targets

Public releases are maintained for Apple Silicon macOS (`darwin-arm64`) and
64-bit Windows (`win32-x64`). The installer selects the host target
automatically.

## Prerequisites

- Node.js 22.19 or newer
- pnpm 11.19.0 (frozen via the repository lockfile)
- Go 1.26 — only needed for contributors and release builders working on the
  Forge runtime; not required to consume the built artifacts. A full
  source-development environment (`pnpm build` then `pnpm dev`) does need Go
  so the daemon can resolve a real platform binary (`.exe` on Windows).

## Develop from source

After a clone, from the repository root (not an installed suite):

```powershell
cd D:\GitHub\wrenyard
pnpm install --frozen-lockfile
pnpm build
pnpm dev
```

macOS uses the same last three commands; only the checkout path changes.
Toolchain versions come from the root `package.json`, the lockfile, and
`runtime/forge/go.mod` (Node >=22.19.0, pnpm 11.19.0, Go 1.26). The install
is allowed to run the Electron native build script (`pnpm-workspace.yaml`
`allowBuilds.electron`). Do not skip that: an install that leaves Electron
missing cannot start Desktop.

`pnpm build` prepares development artifacts only. It does not produce a
release archive, install anything, or start the app.

Daily loop, still from the checkout root:

```powershell
# Keep this terminal running. Save source files to rebuild and restart.
pnpm dev
```

Running `pnpm dev` again from the same checkout replaces the existing dev
stack and loads current code. Source changes rebuild the affected artifacts
and restart both daemon and Desktop. Changes to dev tooling replace the
worker process as well. Ctrl+C stops the stack. In-flight tasks and
conversations may be interrupted; this development loop does not wait for idle.

Source-development and an installed release share the same user config,
state, Desktop `userData`, and DSH session location. The Desktop `userData`
directory is keyed to the installed package identity `@wrenyard/desktop`
(Electron's default for that package), not to the localized **啾啾工坊**
display name, so source-development reuses the settings and DSH session the
installed release already wrote. There is no migration, copy, or Pet-default
workaround, and your existing files are left untouched; set
`WRENYARD_DESKTOP_USER_DATA` to point source-development at a different
directory, and only one Wrenyard instance may use that data domain at a
time. `pnpm dev` first checks for a
running installed Wrenyard Desktop, including a tray-only instance. If it
is still open, the command prints a reminder to fully quit from the tray and
exits without freezing the service or starting source components. Closing
the window is not enough:

```powershell
pnpm dev --kill-desktop
```

That flag applies only to that invocation. It terminates the verified
installed Desktop process tree, waits for it to exit, then replaces the
installed daemon. It does not become the default and never kills unrelated
Electron/Node processes. After exiting dev, you can start the installed release.

Manifest or lockfile changes run `pnpm install --frozen-lockfile` before
rebuilding. Install/build errors remain visible and the watcher waits for
the next save; no release installer is involved. Unexpected component exits
are reported without an automatic crash-restart loop. Save a source file or
run `pnpm dev` again to retry.

## Install (latest-dev)


The latest public development build installs directly from GitHub Releases:

```sh
curl -fsSL https://raw.githubusercontent.com/wrenyard/wrenyard/main/scripts/install.sh | \
  bash -s -- --update --bin-dir "$HOME/.local/bin"
```

```powershell
$installer = Invoke-RestMethod https://raw.githubusercontent.com/wrenyard/wrenyard/main/scripts/install.ps1
& ([scriptblock]::Create($installer)) -Update
```

The command installs the complete product: the suite, the `wrenyard` launcher
at `~/.local/bin/wrenyard`, and 啾啾工坊 in `~/Applications`. Make sure the
launcher directory is on `PATH`. Set `WRENYARD_GITHUB_REPOSITORY` only when
testing a fork or private mirror. Optional `GH_TOKEN` / `GITHUB_TOKEN`
authentication is supported for those private repositories and is never
echoed or embedded in the installed suite. Windows uses the matching
`scripts/install.ps1 -Update` entry point and installs 啾啾工坊 under the
current user's local Programs directory.

On Windows, the old dev27 Desktop updater launches its own bundled installer.
If that updater fails while unpacking the release, run the official one-click
PowerShell installer above once to bootstrap dev28. The dev28 Desktop helper
and later `wrenyard update` runs use the corrected Windows system `tar.exe`
extraction path thereafter.

Binaries come from the newest non-draft **prerelease** of `wrenyard/wrenyard`.
The installer downloads the platform-qualified suite and Desktop ZIPs,
verifies the SHA-256 digests GitHub records for those release assets, and
installs both. No Node, Go, or pnpm is needed by consumers: the packed CLI and
the suite zip bundle the exact Node runtime that built them (`runtime/node` on
POSIX, `runtime/node.exe` on Windows), so the native ABI behavior stays stable
regardless of what is installed on the machine.

Preview binaries are signed ad-hoc on macOS and unsigned by default on Windows
(see [Signing (honest)](#signing-honest)).

## Command surface

- `wrenyard` — print help and enter the unified command surface
- `wrenyard update` — update to the latest-dev build
- `wrenyard desktop` — launch the 啾啾工坊 Desktop product shell
- `wrenyard doctor` — check the local install and report problems
- `wrenyard service` — manage the control-plane service
- `wrenyard task` — delegate and track bounded project work

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

## Uninstall and rollback

To uninstall, remove the install directory and the `wrenyard` shim created by
the installer. To roll back, replace the current install with the previous
suite version; `wrenyard update` and `wrenyard doctor` report the installed
version to help identify the rollback target.

## Building from source

```sh
pnpm install
pnpm build
pnpm test
```

Local release assembly:

```sh
pnpm release:local      # assemble the full local release into .artifacts/release
pnpm release:e2e        # optional packed-install E2E; not a publish gate
pnpm desktop:smoke      # smoke-launch the desktop surface
pnpm release:legal      # verify license/asset provenance metadata
pnpm release:licenses   # verify third-party license notices
pnpm release:check      # manifest + legal verification (also part of pnpm check)
```

`pnpm check` covers workspace checks, identifier/secret scans, manifest and
legal verification, and Go vet/test/build; it does not run packed-install E2E.
These checks are run through the workspace Tasks and repository instructions,
not by GitHub Actions. `pnpm release:local` is build-only: it performs the
compilation, packaging, license-report generation, and payload scrubbing needed
to produce a release without implicitly running `release:check` or tests.

The tag Release workflow installs frozen dependencies, builds each native
target, and publishes only the suite and Desktop archives required by users.
A manual workflow dispatch is build-only and retains those public archives as
downloadable workflow artifacts; it never creates a tag, release, or update
feed.

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
preserved and verified via `pnpm release:legal` / `pnpm release:licenses`.

## Documentation

- [Architecture](docs/architecture.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [Migration history](docs/migration/README.md)
- [Changelog](CHANGELOG.md)
