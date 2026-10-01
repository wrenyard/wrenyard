# Contributing to Wrenyard

Thanks for helping improve Wrenyard, a local-first TypeScript monorepo. This
repository publishes rolling `1.0.0-dev.N` development prereleases. Contributions
are accepted under the [Code of Conduct](CODE_OF_CONDUCT.md), and
security-relevant reports follow [SECURITY.md](SECURITY.md).

## Prerequisites

- Node.js >=24.19.0
- pnpm 11.19.0, enabled through corepack:

  ```sh
  corepack enable
  corepack prepare pnpm@11.19.0 --activate
  ```

## Getting started

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` runs the daemon and Desktop dev scripts in parallel. Start one side
alone with `pnpm --filter @wrenyard/daemon dev` or
`pnpm --filter @wrenyard/desktop dev`. If a lockfile or package manifest
changes, stop the dev scripts, re-run `pnpm install --frozen-lockfile`, and start
them again.

## Checks

Run the root scripts before opening a pull request:

```sh
pnpm lint    # oxlint + repository tsc
pnpm test    # repository tool tests + all package tests
pnpm check   # release gates: public identifiers, secrets, legal, versions
```

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/) in the form
`type(scope): description`, matching the existing history, for example
`fix(desktop): align final style and teardown contracts`. Keep the scope to the
package or app you changed.

## Pull requests

- Keep the change focused on one concern.
- Describe the user-visible effect; include screenshots for UI changes.
- Make sure `pnpm lint` passes.
- Update the documentation when behaviour changes.

## Releases

Maintainers cut the development prereleases; contributors do not tag or publish
releases.
