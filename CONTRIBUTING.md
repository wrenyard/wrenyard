# Contributing to Wrenyard

Wrenyard is one product in one monorepo, currently in a 1.0.0-dev.0
development preview. Contribution acceptance and licensing are governed by
the public policies in this repository.

## Prerequisites

- Node.js 24.19 or newer
- pnpm 11.19.0

Install dependencies with the frozen lockfile, then build once before the
long-running source environment:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm dev
```

`pnpm-workspace.yaml` allows the Electron install script; if Electron is
missing after install, re-run the frozen install rather than assuming a
global Wrenyard/Electron binary.

Daily commands from the same checkout root:

```sh
pnpm dev                              # daemon + Desktop dev scripts, in parallel
pnpm --filter @wrenyard/daemon dev    # daemon only
pnpm --filter @wrenyard/desktop dev   # Desktop only
```

`pnpm dev` runs both dev scripts in parallel with no orchestration, so start order does not matter. The daemon dev script refuses to start while another daemon (for example one started by an installed Desktop) answers on the IPC path, so quit the installed app first. A source Desktop never starts a daemon; it waits until one is available and reconnects automatically. Neither dev script installs a release, changes the installed version, or starts at login.

If a lockfile or package manifest changes, stop the dev scripts, run
`pnpm install --frozen-lockfile`, then start them again.

`pnpm --filter @wrenyard/desktop dev` runs `electron-vite dev --watch`: the renderer updates through Vite with React Refresh, preload changes reload all windows, and main-process changes restart Desktop. The daemon dev script type-checks the daemon after a change, waits for `daemon.status` idle, then restarts only the daemon; shared package changes restart both processes.

## Working in the workspace


Most work happens in a single package. Change into it first and use its
focused commands:

```sh
pnpm --filter <package> <script>
```

At the repository root, the composition checks are:

```sh
pnpm lint              # oxlint + repository tsc
pnpm check             # release gates: public identifiers, secrets, legal, versions
pnpm test              # repository tool tests + all package tests
pnpm build             # Desktop bundle only
```

## Change guidelines

- Keep changesets scoped: name them to the package(s) they affect and
  describe the user-visible change.
- Use focused checks for changed behavior; add or update tests when needed.
- Never commit secrets, internal endpoints, or personal machine paths.
- Use the workspace Tasks and repository instructions to select and record the
  checks appropriate to a change. GitHub Actions intentionally does not run the
  full check composition for main or pull requests.
