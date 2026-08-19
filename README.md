# Wrenyard

[![CI](https://github.com/wrenyard/wrenyard/actions/workflows/ci.yml/badge.svg)](https://github.com/wrenyard/wrenyard/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/wrenyard/wrenyard?include_prereleases&label=latest-dev)](https://github.com/wrenyard/wrenyard/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Wrenyard is a development-preview product that unifies task orchestration, a
precompiled Go runtime, and a desktop observer under one command surface:
**`wrenyard`**.

> **Status: 1.0.0-dev.0 preview.** Installable from source and from the
> latest-dev channel, but not a supported public release. See
> [Status](#status).

## What it is

- **`apps/cli`** — the unified `wrenyard` command surface. The canonical entry
  point, also shipped as a standalone single-file Node SEA executable.
- **`services/foreman`** — the TypeScript control plane that schedules and
  tracks task graph work.
- **`runtime/forge`** — the Go runtime that executes agent work and streams
  activity, shipped as precompiled per-platform packages.
- **`apps/pet`** — the observer surface that reads task and taskgraph progress
  from the control plane over a read-only protocol.
- **`apps/desktop`** — the Desktop DSH shell: an Electron observer surface
  that hosts the task/taskgraph visualizer.
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

The precompiled Forge runtime and the portable suite are built for
`darwin-arm64`, `darwin-x64`, `linux-x64`, and `win32-x64`. The installer
selects the host target automatically.

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

The command installs the launcher at `~/.local/bin/wrenyard`; make sure that
directory is on `PATH`. Set `WRENYARD_GITHUB_REPOSITORY` only when testing a
fork or private mirror. Optional `GH_TOKEN` / `GITHUB_TOKEN` authentication is
supported for those private repositories and is never echoed or embedded in
the installed suite.

Binaries come from the newest non-draft **prerelease** of `wrenyard/wrenyard`.
The installer downloads the platform-qualified suite zip
(`wrenyard-<version>-<target>-suite.zip`), verifies its checksum, and sets up the
`wrenyard` command. No Node, Go, or pnpm is needed by consumers: the packed CLI
and the suite zip bundle the exact Node runtime that built them (`runtime/node`
on POSIX, `runtime/node.exe` on Windows), so the native ABI behavior stays stable
regardless of what is installed on the machine.

Preview binaries are signed ad-hoc on macOS, checksum-only on Linux, and
unsigned by default on Windows (see [Signing (honest)](#signing-honest)).

## Command surface

- `wrenyard` — print help and enter the unified command surface
- `wrenyard update` — update to the latest-dev build
- `wrenyard desktop` — launch the Desktop DSH shell / observer
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
manifests and checksums, and publishes the prerelease.

## Signing (honest)

Preview builds are signed ad-hoc on macOS, checksum-only on Linux, and
unsigned by default on Windows. Ad-hoc signing proves integrity and
buildability, not publisher identity. Trusted release signing is future work
and never runs in this repository. See
[docs/release/signing.md](docs/release/signing.md).

## Status

This is the first public development preview (`1.0.0-dev.0`). Nothing is
published to npm, and no stable release exists. Remaining before a stable
release:

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
