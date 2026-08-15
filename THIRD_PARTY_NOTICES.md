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

## Go module dependencies

Go module license terms are recorded per module and resolved from the
`go.sum`-declared dependency set during the build.

## Exhaustive machine-readable report

Release builds generate the exhaustive dependency license inventory with:

    pnpm licenses list --prod --json

The generated report is written to `.artifacts/release/third-party-licenses.json`
and accompanies release artifacts together with `LICENSE`, `NOTICE` and this
file.

Full upstream license bodies are not reproduced here; refer to each upstream
project's own licensing terms.
