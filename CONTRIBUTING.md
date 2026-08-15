# Contributing to Wrenyard

Wrenyard is one product in one monorepo, currently in a 1.0.0-dev.0
development preview. Contribution acceptance and licensing are governed by
the public policies in this repository.

## Prerequisites

- Node.js 22.19 or newer
- pnpm 11.19.0
- Go 1.26 -- only needed for runtime work

Install dependencies with the frozen lockfile:

```sh
pnpm install --frozen-lockfile
```

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
pnpm release:check     # release manifest validation
pnpm typecheck
pnpm build
pnpm test:workspace
```

## Go (runtime/forge)

Format, test, vet, and build before finishing:

```sh
go -C runtime/forge fmt ./...
go -C runtime/forge test ./...
go -C runtime/forge vet ./...
go -C runtime/forge build ./...
```

## Change guidelines

- Keep changesets scoped: name them to the package(s) they affect and
  describe the user-visible change.
- Any behavior change must include tests.
- Never commit secrets, internal endpoints, or personal machine paths.
- Public-facing code and identifiers are gated: run `pnpm check:identifiers`
  and `pnpm release:check` before finishing.
