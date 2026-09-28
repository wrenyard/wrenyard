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
pnpm dev:desktop
```

`pnpm-workspace.yaml` allows the Electron install script; if Electron is
missing after install, re-run the frozen install rather than assuming a
global Wrenyard/Electron binary.

Daily commands from the same checkout root:

```sh
pnpm dev:desktop    # Terminal A, supervises daemon + Desktop, stays running
pnpm dev:daemon     # supervise only the daemon, no Desktop
```

Source-development reuses the installed user data domain. If a Wrenyard daemon
is already running (for example under an installed Desktop), `pnpm dev:desktop`
prints a reminder to quit 啾啾工坊 fully from the tray or run `wrenyard daemon
stop`, and exits without replacing the service. It does not install a release,
change the installed version, or start at login. After Ctrl+C in the
`pnpm dev:desktop` terminal, open the installed app yourself if you want it
back.

If a lockfile or package manifest changes, stop `pnpm dev:desktop` (Ctrl+C),
reinstall with `--frozen-lockfile`, rebuild, then run it again. The supervisor
does not apply dev-tooling changes automatically.

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
