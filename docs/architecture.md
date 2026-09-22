# Architecture

Wrenyard is one TypeScript product with CLI and Desktop surfaces and a daemon
control plane. Installation and updates belong to the Wrenyard release tools.
There is no separate agent runtime binary or Go build.

## Package boundaries

- `apps/cli` exposes commands and consumes daemon IPC.
- `apps/desktop` owns UI, communication and its passive Pet renderer.
- `services/foreman` owns durable tasks, scheduling and service lifecycle,
  and composes feature services behind IPC handlers.
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
No runtime migration, dual-read fallback or old installer is shipped.

Release assembly bundles the CLI/daemon Node environment and Desktop for the
maintained macOS and Windows targets. Manifest/schema/version tooling describes
only current product components. pnpm owns the source install and build workflow.
Signing details remain in [release/signing.md](release/signing.md).