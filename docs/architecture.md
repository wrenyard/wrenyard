# Architecture

Wrenyard is a local-first TypeScript product. Desktop is the primary product
surface, the `wrenyard` CLI is a thin client, and the daemon is the control
plane. The daemon exposes only an owner-only local IPC surface, its lifecycle
belongs to whichever owner started it, and Desktop owns the installed app's
updates. There is no separate agent runtime binary or Go build.

## Package boundaries

- `apps/cli` exposes commands and consumes daemon IPC. It never starts the
  daemon and requires one to already be running.
- `apps/desktop` owns UI, communication and its in-tree Pet module (windows,
  renderer and resource layout are all Desktop-owned). It also supervises the
  daemon while it runs (tray-resident; closing the window does not quit) and
  applies its own updates.
- `apps/daemon` owns durable tasks and scheduling and composes feature services
  behind owner-only IPC handlers. It has one run entry point,
  `wrenyard daemon run`; the terminal runs it directly, and the packaged
  Desktop and the daemon dev script (`apps/daemon/scripts/dev.ts`) use
  `@wrenyard/daemon/supervisor`.
- `packages/protocol` contains type-only IPC definitions grouped by feature.
  The session contract remains a scaffold; exec and provider have daemon handlers.
- `packages/features/exec` runs raw prompts, owns bounded event replay and
  cancellation. Structured tasks translate their input into this execution API.
- `packages/features/provider` implements provider listing, configuration and
  quota queries. `features/quota` composes HTTP and native client account reads;
  providers interpret the returned observations.
- `packages/providers` and `packages/models` own provider and model definitions.
- `packages/clients/{codex,claude,cursor,grok,codebuddy,opencode,dsh}` implement
  the common agent client interface: installation, arguments, native protocol,
  account reads and token/TPS statistics.
- `packages/execution` owns subprocess lifetime, stdio RPC and native credential
  primitives (read-only SQLite and macOS keychain), without provider knowledge.
- Browser/computer feature packages provide MCP descriptors and instructions;
  clients encode those descriptors in their native configuration.
- `packages/dsh-shell` provides the Desktop conversation integration.

## Runtime surface

The daemon's only external interface is owner-only NDJSON JSON-RPC over a unix
socket (macOS) or a named pipe (Windows). There is no MCP, REST or message HTTP
surface and no listener for external clients. `health.ping` carries an integer
`protocolVersion`; the client validates it and refuses a mismatched daemon
instead of negotiating compatibility.

The gateway is an internal daemon-process-tree feature: the daemon binds
`127.0.0.1:0` (a random loopback port) and mints a fresh in-memory token on
every start. Only daemon-launched agents (through `WRENYARD_GATEWAY_*_URL`
environment variables) and Desktop's embedded DSH sessions (through the
`gateway.connection` IPC method) consume it, and its listener serves only
`/gateway/*` and returns 404 elsewhere. Separately injected stdio MCP servers
(`browser-use`, `computer-use` and task-declared `mcpServers`) are unrelated to
the daemon and remain in place.

## Execution

```text
CLI / Desktop -> protocol -> daemon -> feature
structured task -> exec -> clients -> execution -> native client
provider -> quota -> provider interpretation + clients / HTTP
```

Client events are normalized records. The daemon consumes their session IDs,
terminal status, usage and generation samples directly. Execution targets use
`provider/model:client`; automatic routing uses task requirements. There are no
runtime profile prefixes or legacy policy-tier selectors.

The application permission system is retired. Native unattended-client settings,
request cancellation, repository write coordination and credential redaction
remain separate responsibilities. Retry/backoff/circuit policy is deferred.

## State and distribution

Managed provider keys live in `<XDG_CONFIG_HOME or ~/.config>/wrenyard/providers/auth.json`.
Dispatch aliases live in that config root under `wrenyard/dispatch/config.json`.
Managed client data lives in `<XDG_DATA_HOME or ~/.local/share>/wrenyard/clients`.
Quota observations live in `<XDG_STATE_HOME or ~/.local/state>/wrenyard/quota`.
Official native client credential stores remain owned by those clients.
No runtime migration or dual-read fallback is shipped.

Each release publishes three Desktop artifacts and no suite archive: a Windows
NSIS `setup.exe` (first install and in-app update), a macOS `.dmg` (first
install) and a macOS `.zip` (in-app update). The packaged app carries the
single-file CLI, a Node runtime and the daemon bundle (`daemon/daemon.mjs` plus
only its native and DSH runtime dependencies) under its Resources, so
no system Node or pnpm is needed. Desktop itself performs updates: it reads the
channel feed on the `updates` branch, verifies the artifact SHA-256 and applies
it (`setup.exe /S` on Windows, a verified zip swap on macOS). There is no SEA
install engine, no one-click bootstrap script and no rollback in the first
updater version. The root `package.json` is the single version source, synced
only to the Desktop package. Signing details remain in
[release/signing.md](release/signing.md).