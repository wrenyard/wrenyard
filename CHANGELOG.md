# Changelog

## 1.0.0-dev.0

Development preview release.

### Unified identity

- One product in one monorepo: the `wrenyard` command surface is the single
  public entry point for the CLI, the control plane, the precompiled Go
  runtime, and the desktop observer.
- Legacy compatibility entry points are no longer part of the public command
  surface.

### Release and updater

- Latest-dev installer installs the platform-qualified suite
  (`wrenyard-<version>-<target>-suite.zip`) from the public `wrenyard/wrenyard`
  repository, selecting the host target automatically.
- `wrenyard update` supports updating the local install to the latest-dev
  build, with uninstall and rollback guidance.

### Precompiled runtime

- The Forge Go runtime is shipped as precompiled per-platform packages for
  `darwin-arm64`, `darwin-x64`, `linux-x64`, and `win32-x64`.
- The packed CLI and the portable suite zip bundle the pinned Node runtime
  that built them, keeping native ABI behavior stable.

### Desktop

- The Desktop DSH shell observer surface is introduced as a preview, hosting
  the task/taskgraph visualizer.

### Pet

- The Pet observer surface preview reads task and taskgraph progress from the
  control plane over a read-only protocol.

### Signing (honest)

- Preview builds are signed ad-hoc on macOS, checksum-only on Linux, and
  unsigned by default on Windows; trusted release signing is future work and
  never runs in this repository.
