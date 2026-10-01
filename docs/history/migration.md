# Migration history

Historical notes for users upgrading from early previews.

Wrenyard is one public product in one monorepo. This note records the
migration to the unified `wrenyard` identity.

## Unified release, state, and paths

Release artifacts, local state, and install paths are consolidated under the
unified `wrenyard` identity. Each release publishes three Desktop installers
(Windows `setup.exe`, macOS `.dmg` and macOS in-app-update `.zip`); there is no
suite zip and no one-click bootstrap script. Legacy release/state paths and
legacy compatibility commands are not part of the public contract; consumers of
an early `1.0.0-dev.N` preview should use the `wrenyard` command surface only.
No user-specific machine paths are used by the public contract.

## Signing

Preview builds are signed ad-hoc on macOS and unsigned by default on Windows.
Trusted release signing is future work and never runs in this repository.

## Upgrading from a release with external client configuration

Earlier preview releases could point your own Claude Code, Codex, Grok Build or
Claude App configuration at the Wrenyard gateway from the Desktop “客户端”
(Clients) page. That feature is removed, and there is no automatic restoration.

- **Before upgrading,** open the old Desktop, go to the Clients page and click
  **Restore** for each configured client.
- **If you already upgraded,** the page is gone. Manually remove the base URL
  and credential-helper entries Wrenyard wrote from each affected tool's
  configuration so it stops pointing at `127.0.0.1:8787/gateway/...`.

The canonical public source is `https://github.com/wrenyard/wrenyard`.
