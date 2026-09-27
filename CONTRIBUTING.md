# Contributing to Wrenyard

Wrenyard is one product in one monorepo, currently in a 1.0.0-dev.0
development preview. Contribution acceptance and licensing are governed by
the public policies in this repository.

## Prerequisites

- Node.js 22.19 or newer
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
pnpm dev              # Terminal A, stays running
pnpm dev --kill-desktop   # same start; terminate a stuck installed Desktop first
```

Source-development reuses the installed user data domain. `pnpm dev` first
checks for a running installed Wrenyard Desktop; if one is open it prints a
reminder to quit from the tray and exits without replacing the service or
starting source components. Pass `--kill-desktop` once to terminate that
Desktop tree instead. It does not install a release, change `current`, or
start at login. After Ctrl+C in the `pnpm dev` terminal, open the installed
app yourself if you want it back.

If a lockfile or package manifest changes, interrupt `pnpm dev` (Ctrl+C),
reinstall with `--frozen-lockfile`, rebuild, then `pnpm dev`. Saving
watcher/supervisor source while `pnpm dev` is running replaces that worker;
otherwise interrupt and run `pnpm dev` again. Unexpected component exits are
reported as degraded; save a file or run `pnpm dev` again to restore.

## Working in the workspace


Most work happens in a single package. Change into it first and use its
focused commands:

```sh
pnpm --filter <package> <script>
```

At the repository root, the composition checks are:

```sh
pnpm check             # full check composition
pnpm check:identifiers # public identifier / release-boundary gate
pnpm release:check     # license and asset-provenance verification
pnpm typecheck
pnpm build
pnpm test:workspace
```

## Change guidelines

- Keep changesets scoped: name them to the package(s) they affect and
  describe the user-visible change.
- Use focused checks for changed behavior; add or update tests when needed.
- Never commit secrets, internal endpoints, or personal machine paths.
- Use the workspace Tasks and repository instructions to select and record the
  checks appropriate to a change. GitHub Actions intentionally does not run the
  full check composition for main or pull requests.
