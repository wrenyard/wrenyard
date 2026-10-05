# Third-Party Notices

This distribution contains first-party Wrenyard software and third-party
components. Wrenyard source is licensed under the MIT License (see LICENSE,
Copyright (c) 2026 Dluckxx). Every third-party component remains under its own
license, which controls that component; Wrenyard does not claim ownership of
any third-party software.

## Direct redistributed and runtime dependencies

| Component | License | Copyright |
| --- | --- | --- |
| DeepSeek Harness (`@deepseek-ai/dsh`) | MIT | © 2026 DeepSeek |
| Node.js | MIT (with additional bundled notices) | Node.js contributors |
| Electron | MIT (with Chromium bundled notices) | OpenJS Foundation and Electron contributors |
| electron-builder | MIT | electron-builder contributors |
| PixiJS | MIT | PixiJS contributors |
| better-sqlite3 | MIT | better-sqlite3 contributors |
| esbuild | MIT | esbuild contributors |
| postject | MIT | postject contributors |
| archiver | MIT | archiver contributors |
| sharp (`sharp`) | Apache-2.0 | Copyright 2013 Lovell Fuller and others |
| sharp native prebuilds (`@img/sharp-<platform>`) | Apache-2.0 | See bundled sharp source notices |
| libvips native package (`@img/sharp-libvips-<platform>`) | LGPL-3.0-or-later | See bundled upstream library notices; the package README lists its individual bundled library licenses |

Release builds that bundle the session image pipeline ship sharp's
platform-selected native packages (`@img/sharp-<platform>` and
`@img/sharp-libvips-<platform>`). The release dependency-copy and pruning steps
preserve each native package's `README`, license metadata and `package.json`, so
the libvips native package README and its individual bundled-library license
listings travel with the shipped package.

## Machine-readable inventory

The dependency license inventory can be inspected from the lockfile with
`pnpm licenses list --prod --json`. Release builds do not generate a license
report; the suite zip carries `LICENSE`, `NOTICE` and this file.

Full upstream license bodies are not reproduced here; refer to each upstream
project's own licensing terms.
