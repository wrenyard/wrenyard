# Signing

Wrenyard is one public product in one monorepo; Foreman, Forge, Pet, and the
Desktop shell are internal components. Two signing levels are supported:
local/CI preview signing and trusted release signing. No certificates,
private keys, or personal identifiers are ever committed to the repository,
and no user-specific paths or secrets appear in signing configuration.

## Local / CI preview

Preview artifacts are signed to prove integrity and buildability, not
publisher identity.

- macOS: Node SEA artifacts and Desktop `.app` bundles are re-signed ad-hoc
  with `codesign --sign -` and then verified with `codesign --verify`.
- Linux: checksum-only; no code signing is performed.
- Windows: unsigned by default; artifacts are signed only when signtool
  credentials are available (see below).

## Trusted release (future)

Trusted release signing is a future step. It consumes credentials exclusively
from the environment and stays disabled when those credentials are absent; it
never runs in this repository today.

- macOS: `CSC_LINK` / `CSC_KEY_PASSWORD` for electron-builder code signing,
  and `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` for
  notarization.
- Windows: Windows certificate selectors via `CSC_LINK` / `CSC_KEY_PASSWORD`
  or a `WRENYARD_WINDOWS_CERT_SHA1` signtool identity.
- Notarization and trusted signing remain disabled when the relevant
  credentials are not present.

## Bundled Node runtime

The packed CLI tarball and portable suite zip ship a pinned current-platform
Node runtime (`runtime/node` on POSIX, `runtime/node.exe` on Windows) taken
from the exact `node@22.19.0` build dependency. It is covered by the artifact
checksums and the third-party notices, but it is signed only by the upstream
Node.js project where applicable; no trusted signature is claimed on the
bundled copy. Applying trusted platform signing/notarization to every
executable in the portable suite — including the bundled Node runtime —
remains an external release credential step that never runs in this
repository.

## Unified release, state, and paths

Release artifacts, local state, and install paths are consolidated under the
unified `wrenyard` identity. Legacy release/state paths and legacy
compatibility commands are not part of the public contract and are not
documented for consumers.

## Guarantees

- Certificates, private keys, and Apple identifiers are never committed and
  are never echoed by tooling.
- Ad-hoc signing proves integrity and buildability; it does not assert
  publisher identity.
