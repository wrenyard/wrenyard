# @wrenyard/protocol

Type-only IDL for the Wrenyard IPC conversation protocol. `1.0.0-dev.35`,
private, MIT, ESM, zero runtime dependencies.

> **These types DO NOT VALIDATE incoming JSON.**
>
> Nothing in this package parses, checks, sanitizes, dispatches, or stores a
> message. A value typed as `ConversationSnapshot` is a compile-time claim about
> a wire shape, not a runtime guarantee. **Runtime validation stays at the
> adapter** on the transport boundary. Treat every payload crossing the wire as
> untrusted.

## Boundaries

This package is an isolated protocol shape. It deliberately does **not**
contain, and must not grow, any of the following:

- runtime validators or type guards (schema generation is a future design choice)
- request handlers, routers, registries with runtime entries, or dispatch
- sockets, pipes, connections, reconnection, or transport of any kind
- persistence, storage, caching, or session lifecycle management
- native client types (`node:*`, Electron, DOM), or any Node/Electron import
- desktop UI state, view models, or presentation projections
- runtime dependency on any Wrenyard business package

It also does not implement the session engine: `@wrenyard/session` owns the DSH
backend, persistence and recovery. The types here are the shape it projects.

### Relationship to existing code

This package is **not** the existing worker/daemon session surface and **not**
`message.send`. The conversation DTOs here are the product conversation API that
`@wrenyard/session` returns and `@wrenyard/control-client/session` transports.
The existing `apps/daemon/lib/protocol` wire shape is unchanged and is not
imported here; the JSON-RPC envelope shape is mirrored so the adapter can carry
both.

Types are declared as regular interfaces without index signatures. JSON
serialization safety comes from each concrete DTO being composed only of
JSON-safe fields, never from forcing every DTO to accept arbitrary extra keys.

## Directory map

```
src/
  index.ts              root composition: feature maps -> protocol maps and
                        root typed request/response/notification unions
  common/
    json.ts             JsonPrimitive / JsonValue / JsonObject (JSON-safe)
    jsonrpc.ts          JSON-RPC 2.0 envelopes + standard numeric error codes
    methods.ts          RpcMethod / RpcNotification descriptors and the
                        helpers that infer params, results, requests, responses
    index.ts
  session/
    types.ts            ConversationSnapshot + every product DTO it carries
    methods.ts          method param/result pairs + SessionMethods, and the
                        (currently empty) SessionNotifications map
    index.ts
  exec/
    types.ts            ExecSnapshot + ExecEventEnvelope (no process/env fields)
    methods.ts          the four method param/result pairs + ExecMethods
    errors.ts           ExecErrorData discriminated by kind
    index.ts
  examples/
    exec.ts             static typed example data (satisfies, no casts)
README.md
package.json
tsconfig.json
```

`package.json` exports the source directly: `.` -> `src/index.ts`,
`./common` -> `src/common/index.ts`, `./session` -> `src/session/index.ts`,
`./exec` -> `src/exec/index.ts`.
There is intentionally **no build pipeline**; a `typecheck` script is declared
but nothing in this task runs it.

## Session methods

Ten methods, each with explicit named `Params`/`Result` types. Wire names are
the map keys in `SessionMethods`.

| Method | Params | Result |
| --- | --- | --- |
| `session.snapshot` | `{ afterRevision?, waitMs? }` | `SessionSnapshotResult` |
| `session.select` | `{ sessionId }` | `SessionSnapshotResult` |
| `session.create` | `{}` | `SessionSnapshotResult` |
| `session.selectModel` | `{ provider, model, reasoningEffort? }` | `SessionSnapshotResult` |
| `session.send` | `{ text, clientTimeZone? }` | `SessionSnapshotResult` |
| `session.cancel` | `{ turnId? }` | `SessionSnapshotResult` |
| `session.setWorkspace` | `{ workspace }` | `SessionSnapshotResult` |
| `session.summary.model.get` | *none* | `{ summary }` |
| `session.summary.model.set` | `{ canonicalModel }` | `{ summary }` |
| `session.backend` | *none* | `SessionBackendResult` |

Contract semantics the adapters honor:

- **Every action returns the full projection.** `SessionSnapshotResult` is
  `{ conversation, revision }`, where `conversation` is the complete
  `ConversationSnapshot`. A caller replaces the projection it holds; it never
  merges a delta, so two callers cannot diverge.
- **`session.snapshot` is the only read.** `afterRevision` is the revision the
  caller already holds. When it equals the current revision the call waits for
  the next change or terminal flush — bounded by `waitMs`, never more than
  1000ms — and still returns a *complete* snapshot. A different revision, or an
  omitted one, returns immediately. Continuous updates are pull-based; there is
  no push channel.
- **`revision` is monotonic and epoch-seeded**, so it never resets within a
  process and a cursor captured before a reconnect can never be mistaken for a
  live one. A reconnecting client re-reads with no cursor at all.
- **`session.cancel`** addresses one turn by `turnId` (or the oldest running turn
  of the selected conversation when absent). Only that turn's own execution
  branch and its owned task runs are stopped, so parallel turns and other
  conversations are unaffected.
- **`session.setWorkspace`** switches the bound workspace. The workspace is
  validated against the configured workspace root first; a mismatch is refused
  instead of silently rebinding the conversation.
- **`session.summary.model.get` / `.set`** carry `SummarySettingsSnapshot`:
  the persisted canonical model id plus the options the live local model Gateway
  can actually serve.
- **`session.backend`** is main-process diagnostics only — it reports the DSH
  child process state (`starting`, `running`, `stopped`, `failed`). It is never
  projected to the renderer.

`SessionNotifications` is intentionally empty: nothing is pushed today.

### Recommended read flow

1. Read once with no `afterRevision` to seed the projection and its `revision`.
2. Re-issue `session.snapshot` with `afterRevision: <last revision>, waitMs: 1000`
   in a loop. Each reply replaces the projection and advances the cursor; a
   reconnect starts again from step 1 with no cursor.

## Typed usage

```ts
import type {
  ProtocolResponse,
  RpcTypedRequest,
  SessionMethods,
  SessionSendParams,
} from '@wrenyard/protocol'

// Params/results are inferred from the feature map, not restated:
type SnapshotRequest = RpcTypedRequest<SessionMethods, 'session.snapshot'>
//   -> { jsonrpc: '2.0'; method: 'session.snapshot'; params: SessionSnapshotParams; id: JsonRpcId }
type SendResponse = ProtocolResponse<'session.send'>
//   -> success carrying SessionSendResult, or an error response

const sendParams = {
  text: 'hello',
  clientTimeZone: 'Asia/Shanghai',
} satisfies SessionSendParams
```

Root aliases keep the method <-> params relationship:

```ts
import type { ProtocolRequestUnion } from '@wrenyard/protocol'

function handle(request: ProtocolRequestUnion) {
  switch (request.method) {
    case 'session.select':
      // request.params is narrowed to SessionSelectParams here
      return request.params.sessionId
    case 'session.send':
      // request.params is narrowed to SessionSendParams here
      return request.params.text
    default:
      return undefined
  }
}
```

Typed sample payloads using `satisfies` live in `src/examples/exec.ts`. They are
not imported at runtime. JSON-RPC responses contain no method name: a client
matches the response id to a pending request before selecting the corresponding
result type.

## Exec methods

Four methods for raw prompt execution. `exec.start` accepts a prompt against an
already-resolved client/model, returns a snapshot immediately, and the caller
follows progress through `exec.events`. Wire names are the map keys in
`ExecMethods`.

| Method | Params | Result |
| --- | --- | --- |
| `exec.start` | `{ client, provider?, model, mode?, prompt, cwd, resumeSessionId?, thinking?, features? }` | `{ execution }` |
| `exec.get` | `{ id }` | `{ execution }` |
| `exec.events` | `{ id, afterSeq? }` | `{ events, nextSeq }` |
| `exec.cancel` | `{ id }` | `{ id, status }` |

`ExecSnapshot` is `{ id, client, status, createdAt, finishedAt?, exitCode?,
error? }`, with `status` one of `running`, `completed`, `failed`, `cancelled`.
An `ExecEventEnvelope` is `{ id, seq, event }`, where `event` is the normalized
agent record as a JSON-compatible object; the protocol does not interpret it.
`exitCode` is a number, `null` when the child was signalled, or absent while the
execution runs.

Draft semantics a future adapter must honor:

- **`exec.start` is acceptance, not completion.** The snapshot may still be
  `running`. `exec.start` is also where a caller-visible configuration failure
  belongs: an unknown client or an unknown feature id must be rejected before
  anything is spawned, so a rejected start never leaves a half-configured run.
- **`exec.events` is exclusive on `afterSeq`**, ascending on the per-execution
  positive safe-integer `seq`. An omitted `afterSeq` means `0`, i.e. the
  beginning of retained history. `nextSeq` is the last returned `seq`, or the
  input when empty, so a client may poll with it again without advancing.
- **Bounded history means a cursor can expire.** History is retained under
  count and byte ceilings, so `afterSeq` can fall behind the oldest retained
  record. That is a real gap and must surface as `exec_cursor_expired` with
  `oldestRetainedSeq`; returning a truncated page as if it were complete would
  silently corrupt a consumer's projection.
- **`exec.cancel`** is cooperative and idempotent. It returns the status after
  the request, which may still be `running` until the terminal event arrives;
  cancelling an already-terminal execution reports that terminal status rather
  than an error.
- **Terminal executions are retained for a bounded time**, then dropped. A
  `get`, `events` or `cancel` for a dropped execution is `exec_not_found` — it
  is not proof the execution never existed.

An `exec.start` request has no field for a process environment, executable path,
credential, timeout or retry policy, and a snapshot exposes none of those
either. Raw child stdout/stderr does not cross this wire; the normalized agent
event record is the only transport detail carried.

Exec errors are discriminated on `kind`: `exec_not_found`,
`exec_client_unavailable`, `exec_cursor_expired`, `exec_feature_unknown`.
**None of them has an assigned numeric wire code**; the adapter must define the
mapping.

## Future feature migration

To add a feature (for example `taskgraph`):

1. Add `src/<feature>/{types,methods,events,errors,index}.ts`, declaring an
   `XMethods` interface of `RpcMethod` entries and, if it has push, an
   `XNotifications` interface of `RpcNotification` entries. Feature maps are
   plain interfaces: the helpers validate each entry structurally and never
   force an index signature, so a feature cannot silently accept extra keys.
2. Compose it in `src/index.ts`:

   ```ts
   export interface ProtocolMethods extends SessionMethods, TaskgraphMethods {}
   export interface ProtocolNotifications extends SessionNotifications, TaskgraphNotifications {}
   ```

   Conflicting inherited definitions are type errors; features never override
   one another. Keep wire names globally unique. The
   root request/response/notification unions then pick the feature up
   automatically — no per-feature alias file is needed.
3. Add subpath exports in `package.json` if the feature should be importable
   on its own (`./<feature>`).

Migrating an existing surface (for example the legacy `message.send`) has two
rules:

- **Preserve legacy wire names and fields.** Keep snake_case field names and
  existing method names exactly as they are on the wire; the DTOs are the
  adapter's target, not a wire rename.
- **Runtime remains outside protocol.** Feature services may consume these
  type-only contracts. Transport adapters own validation and numeric error-code
  assignment; protocol never imports the feature implementation.

## Provider surface

`@wrenyard/protocol/provider` declares `provider.list`, `provider.configure`
and `provider.quota`. The first two preserve their existing wire shapes.
`provider.quota` accepts `{ forceRefresh?: boolean }` and returns
`{ providers: ProviderQuotaSnapshot[], fetchedAt: number }`. Each quota row
preserves status, windows, balances and reset metadata; `fetchedAt` is epoch
milliseconds. It does not require the retired CLI `display_line` field.

The daemon validates and dispatches these methods over local IPC to
`@wrenyard/provider-service`. Desktop and CLI use the same quota source.

## Implementation status

The session contract here is the real, implemented surface: `@wrenyard/session`
projects `ConversationSnapshot` with a monotonic revision, and
`@wrenyard/control-client/session` transports it. Exec and provider handlers
exist in the daemon. The protocol package itself still has no runtime wiring and
never imports a feature implementation.
