# Migration note

Wrenyard is one public product in one monorepo. This note records the
migration to the unified `wrenyard` identity.

## Unified release, state, and paths

Release artifacts, local state, and install paths are consolidated under the
unified `wrenyard` identity. Legacy release/state paths and legacy
compatibility commands are not part of the public contract; consumers of the
1.0.0-dev.0 preview should use the `wrenyard` command surface only. No
user-specific machine paths are used by the public contract.

## Internal components

Foreman, Forge, Pet, and the Desktop shell are internal components of the
single Wrenyard product. This public repository begins with one audited,
clean-history source snapshot; no component's private development history is
included. Forge, Foreman, and Pet provenance identifiers remain documented so
the composition of the initial snapshot can be audited without exposing the
source repositories or their histories.

See [source-snapshots.md](./source-snapshots.md) for the tracked snapshot
provenance.

## Signing

Preview builds are signed ad-hoc on macOS, checksum-only on Linux, and
unsigned by default on Windows. Trusted release signing is future work and
never runs in this repository.

The canonical public source is `https://github.com/wrenyard/wrenyard`.
