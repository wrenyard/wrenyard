# Wrenyard Architecture

Wrenyard is one public product in one monorepo: TypeScript control and UX
surfaces plus a precompiled Go runtime. Foreman, Forge, Pet, and the Desktop
shell are internal components of that single product.

## Components

- **apps/cli** -- the unified `wrenyard` command surface. Depends on
  `packages/control-client` and `packages/runtime-resolver` to talk to the
  control plane and locate the runtime.
- **services/foreman** -- the control plane. Schedules and tracks task graph
  work. Launches the `forge` executable and the `pet` process.
- **runtime/forge** -- the Go runtime that executes agent work and streams
  activity. It has no dependency on Node.
- **apps/pet** -- the observer surface. Reads task and taskgraph progress from
  Foreman over a read-only control protocol.
- **apps/desktop** -- the Desktop DSH shell: an Electron observer surface that
  hosts the task/taskgraph visualizer.
- **packages/dsh-shell** -- the dsh profile/bundle shell reused by the desktop
  host.
- **packages/control-client** -- the typed client for the control-plane
  protocol.
- **packages/runtime-resolver** -- resolves which runtime binary to use.
- **packages/runtime-*** -- auditable staging manifests for the CI-built
  precompiled Forge runtime payloads.

## Dependency direction

- CLI -> control-client, runtime-resolver
- Foreman -> Forge executable and Pet process
- Pet -> Foreman (read-only control protocol)
- Desktop -> dsh-shell, Pet/Foreman observer surfaces
- Forge has no dependency on Node

## Execution and distribution

In development execution, the CLI, control plane, and runtime all run from
the repository. Release artifacts are assembled locally: the Forge Go runtime
is precompiled and shipped as per-platform packages (`darwin-arm64`,
`darwin-x64`, `linux-x64`, `win32-x64`), and the packed CLI and portable
suite zip bundle the pinned Node runtime that built them. Preview builds are
installable from the latest-dev channel; nothing is published to npm or
GitHub Releases.

## Unified release, state, and paths

Release artifacts, local state, and install paths are consolidated under the
unified `wrenyard` identity. Components declare versions through the
cross-component release-manifest contract under `contracts/`. `pnpm
release:check` validates that the manifest is consistent.

## Signing

Preview builds are signed ad-hoc on macOS, checksum-only on Linux, and
unsigned by default on Windows. Trusted release signing is future work and
never runs in this repository. See
[docs/release/signing.md](release/signing.md).

## Why pnpm is the single user entry

Even though the runtime builds separately in Go, pnpm remains the single
entry point for users and developers: workspace installs, builds, tests, and
the unified `wrenyard` command all run through pnpm. Go tooling is exercised
from the workspace when needed.
