# Architecture

Wrenyard is a local-first TypeScript product. Desktop is the primary product
surface, the `wrenyard` CLI is a thin client, and the daemon is the control
plane. The daemon exposes only an owner-only local IPC surface, its lifecycle
belongs to whichever owner started it, and Desktop owns the installed app's
updates. There is no separate agent runtime binary or Go build.

## Package boundaries

- `apps/cli` exposes commands and consumes daemon IPC. It never starts the
  daemon and requires one to already be running.
- `apps/desktop` owns UI, communication and Pet, an in-process module at
  `apps/desktop/src/pet` (windows, renderer and resource layout are all
  Desktop-owned). It also supervises the daemon while it runs (tray-resident;
  closing the window does not quit) and applies its own updates.
- `apps/daemon` owns durable tasks, sessions, bots and routines and composes
  feature services behind owner-only IPC handlers. It has one run entry point,
  `wrenyard daemon run`; the terminal runs it directly, and the packaged
  Desktop and the daemon dev script (`apps/daemon/scripts/dev.ts`) use
  `@wrenyard/daemon/supervisor`.
- `packages/protocol` contains type-only IPC definitions grouped by feature.
  The session contract is implemented: the daemon hosts the ledger session over
  `@wrenyard/session` and exposes the `session.*` IPC methods, with Desktop as
  the conversation client. Exec and provider have daemon handlers.
- `packages/features/session` is the conversation core. Each main reasoning
  request appends to the previous one, the main model declares typed `search`,
  `dispatch`, `document`, `vcs` and `project` actions through one native tool,
  cheap auxiliary models carry them out, and the request runs over Chat
  Completions, Responses or Anthropic Messages depending on the protocols the
  model declares. See the [session feature](../packages/features/session/README.md).
- Bots are daemon-hosted agents defined by `<workspace>/bots/<id>/` (or `<config root>/bots/<id>/` for a device-only bot), with each device's routines in `<config root>/bots/<id>/routines/`.
  The bot kernel queues wakes per bot, runs one turn at a time per bot over the
  session engine with the bot's own system prompt and its enabled native tools
  (`session`, `todo`, `message`), and watches the sessions a bot starts. The
  scheduler fires routines owned by bots. Workspace todos are Markdown files in
  `<workspace>/todos/` behind the `todo.*` methods. See the
  [bots guide](guides/bots.md).
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
- `packages/themes` holds pure theme tokens, metadata and icons consumed by
  Desktop.

## Runtime surface

The daemon's only external interface is owner-only NDJSON JSON-RPC over a unix
socket (macOS) or a named pipe (Windows). There is no MCP, REST or message HTTP
surface and no listener for external clients. `health.ping` carries an integer
`protocolVersion`; the client validates it and refuses a mismatched daemon
instead of negotiating compatibility. Desktop can instead connect to a daemon on
another machine: it reaches that daemon's IPC endpoint through an SSH tunnel,
provisions a compatible daemon there when needed, and keeps exactly one active
endpoint (local or one remote host) at a time.

The gateway is an internal daemon-process-tree feature that listens only on
`127.0.0.1`; it never binds a public interface. Its port is a persisted setting:
`random` (the default) lets the OS assign a free loopback port at bind time,
while `fixed` uses a validated user-chosen port 1–65535. A saved change only
takes effect the next time the gateway binds (daemon start); saving never
rebinds, restarts or rotates the running listener, and a fixed port that is
already taken fails with an actionable conflict instead of falling back to
another port. The gateway token is generated once with a CSPRNG and persisted
with the same restricted-permission config write as every other setting, then
reused across restarts, so restarting the daemon does not invalidate existing
credentials; replacing the token likewise takes effect at the next bind, after
which the previous token is rejected. The connection actually in effect (host,
bound port, the three `http://127.0.0.1:<port>/gateway/...` base URLs and the
effective token) is shown under Settings > 运行环境 > Gateway 接入 and exposed to local clients
over the IPC-only `gateway.connection` / `gateway.settings` methods; external
clients such as Zed are configured manually by copying those details, and
Wrenyard never writes another application's configuration. Only daemon-launched
agents (through `WRENYARD_GATEWAY_*_URL` environment variables) and Desktop's
embedded DSH sessions consume it, and its listener serves only `/gateway/*` and
returns 404 elsewhere. ChatGPT subscription models are
forwarded over the Responses protocol with the Codex client's existing ChatGPT
login, which the daemon reads and refreshes through that client. Browser
operations use the daemon-managed `agent-browser` CLI and desktop operations
use the Cua Driver MCP; both are managed by the daemon's operation-component
service (Settings > 操作组件) and attached per run by one execution adapter.
Task-declared `mcpServers` are unaffected.

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
remain separate responsibilities. Main reasoning uses one retry and circuit
policy: a local circuit-admission refusal from the Gateway does not consume the
transport's same-route upstream retry budget, and a bounded, cancellable wait
honours the route's retry-after hint.

## Routing exclusions

Global model and provider exclusions live at the config root under
`routing.exclude`:

```json
{
  "routing": {
    "exclude": {
      "models": ["provider/model"],
      "providers": ["provider"]
    }
  }
}
```

Both entries are arrays of ids: `models` accepts bare model ids or unified
`provider/model` ids, `providers` accepts bare provider ids. Exclusions
configured for one specific task stay in that task's own settings and keep
their names and behaviour; only the machine-wide exclusions use
`routing.exclude`.

Per-role exclusions live in the same place, under `routing.exclude.roles`:

```json
{
  "routing": {
    "exclude": {
      "roles": {
        "reply": {
          "models": ["provider/model"],
          "providers": ["provider"]
        }
      }
    }
  }
}
```

Each role key holds its own `models` and `providers` arrays, with the same
entry formats as the global lists: `models` accepts bare model ids or unified
`provider/model` ids, `providers` accepts bare provider ids. A role's lists
apply only to that role's own automatic selection — the auxiliary roles (for
example `status`, `title`, `suggestion`, `reply` and `dispatch`), the task
roles, which are keyed by task name, and bot selection — and they are layered
on top of the global lists. Explicit user choices and the Gateway are
unaffected. Unknown keys under `routing.exclude` and inside a role entry fail
config load with an error naming the key and scope; empty lists are accepted
and mean no exclusions.

Earlier builds stored the machine-wide lists under
`tasks.settings.global.dispatch.excludeModelIds` / `excludeProviderIds`. On the
first read after upgrading, the daemon moves those values into
`routing.exclude` — values already at `routing.exclude` come first, the legacy
entries are appended after them, and duplicates are removed while keeping
order — deletes the old keys, writes the configuration back in a single atomic
write and logs one line. A configuration that has already been migrated is left
byte-identical.

## State and distribution

Managed provider keys live in `<XDG_CONFIG_HOME or ~/.config>/wrenyard/providers/auth.json`.
Dispatch aliases live in that config root under `wrenyard/dispatch/config.json`.
Managed client data lives in `<XDG_DATA_HOME or ~/.local/share>/wrenyard/clients`.
Quota observations live in `<XDG_STATE_HOME or ~/.local/state>/wrenyard/quota`.
In that state root, session ledgers live under `session/`, a session's attached
files under `sessions/<sessionId>/files`, each task run's output files under
`artifacts/<runId>` and bot state and conversations under `bot-agents/`. Bot
definitions live in the workspace under `bots/`, and device bots and routines
in the config root under `wrenyard/bots/`.
Official native client credential stores remain owned by those clients.
No runtime migration or dual-read fallback is shipped.

Each release publishes three Desktop artifacts and no suite archive: a Windows
NSIS `setup.exe` (first install and in-app update), a macOS `.dmg` (first
install) and a macOS `.zip` (in-app update). The packaged app carries the
single-file CLI, a Node runtime and the daemon bundle (`daemon/daemon.mjs` plus
only its native runtime dependencies) under its Resources, so
no system Node or pnpm is needed. Desktop itself performs updates: it reads the
canonical `latest.json` feed on the `updates` branch (`dev.json` is kept as a
legacy compatibility alias), verifies the artifact SHA-256 and applies it
(`setup.exe /S` on Windows, a verified zip swap on macOS). There is no SEA
install engine, no one-click bootstrap script and no rollback in the first
updater version. The root `package.json` is the single version source, synced
only to the Desktop package. Signing details remain in
[release/signing.md](release/signing.md).