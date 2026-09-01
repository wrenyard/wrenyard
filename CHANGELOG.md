# Changelog

## 1.0.0-dev.21

Development preview release.

### Application updates

- Add Help → Check for Updates with native current/update/download/restart
  dialogs and a one-hour GitHub Releases cache shared by automatic and manual
  checks.
- Add recoverable atomic Desktop replacement on Apple Silicon macOS and
  Windows x64. The external helper updates Desktop and the suite together,
  rolls back Desktop when the suite update fails, and relaunches the app.
- Verify release archives with GitHub's recorded SHA-256 asset digest so future
  releases no longer need public checksum sidecars.

### Distribution

- Maintain public releases for `darwin-arm64` and `win32-x64` only.
- Publish only the suite and Desktop archives required by users; manifests,
  component packages, installers, notices and aggregate checksums remain CI
  evidence.
- Make the one-command installer bootstrap the full suite and Desktop product.

## 1.0.0-dev.16

Development preview release.

### Desktop productization

- Add a model picker to conversations with availability-aware ordering and a
  shared user-controlled order across model and Provider surfaces.
- Replace the quota page with the localized Provider directory, including Key
  configuration, friendly login/configuration states, aligned quota rows, and
  a single public CodeBuddy identity.
- Use the 「工坊工作区」 product name, show the suite version in the title bar,
  add rotating workshop prompt copy, and reduce daemon readiness to a status
  lamp with uptime details.

### Updates

- Add non-blocking stable/development update channels to Desktop settings.
- Verify Desktop and suite assets with checksums before staging; macOS applies
  them through an external transactional helper with rollback and active-work
  guards.

### Providers and models

- Add public API Provider modules for OpenAI, Anthropic, Zhipu, Moonshot,
  MiniMax, Qwen, Tencent Cloud TokenHub, and Volcengine while keeping native
  subscription credentials distinct.
- Update DeepSeek and CodeBuddy model catalogs, adopt the SpaceXAI Provider
  name, and require the selected client binary before a profile is offered.
- Record only unambiguous, non-rate-limit CodeBuddy monthly exhaustion locally;
  mixed monthly and transient errors never persist until the next month.

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
