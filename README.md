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
  Forge runtime; not required to consume the built artifacts

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
- `wrenyard task` — schedule and track task-graph work

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
The tag Release workflow also skips that E2E: it packs each target, verifies
the full internal manifests and checksums, and publishes only the suite and
Desktop archives required by users.

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
