# @wrenyard/protocol

Type-only IDL for the Wrenyard IPC conversation protocol. `1.0.0-dev.35`,
private, MIT, ESM, zero runtime dependencies.

> **These types DO NOT VALIDATE incoming JSON.**
>
> Nothing in this package parses, checks, sanitizes, dispatches, or stores a
> message. A value typed as `Session` is a compile-time claim about a wire
> shape, not a runtime guarantee. **Runtime validation must stay at future
> adapters** on the transport boundary. Until such an adapter exists, treat
> every payload crossing the wire as untrusted.

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

It also does not implement the session engine. "A session stores messages and
owns turns" describes the contract a future feature service must satisfy; it is
not a description of code in this repository.

### Relationship to existing code

This package is **not** the existing worker/daemon session surface and **not**
`message.send`. The conversation DTOs here describe a future product
conversation API. The existing `apps/daemon/lib/protocol` wire shape and
`packages/control-client` transport are unchanged and are not imported here;
the JSON-RPC envelope shape is mirrored so the future adapter can carry both.

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
    errors.ts           known numeric protocol codes (SESSION_NOT_FOUND -32003)
    index.ts
  session/
    types.ts            ids, epoch ms, SessionSummary/Session/Message/Turn
    methods.ts          the seven method param/result pairs + SessionMethods
    events.ts           SessionEvent union + SessionNotifications (future push)
    errors.ts           SessionErrorData discriminated by kind
    index.ts
  exec/
    types.ts            ExecSnapshot + ExecEventEnvelope (no process/env fields)
    methods.ts          the four method param/result pairs + ExecMethods
    errors.ts           ExecErrorData discriminated by kind
    index.ts
  examples/
    session.ts          static typed example data (satisfies, no casts)
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

Seven methods, each with explicit named `Params`/`Result` types. Wire names are
the map keys in `SessionMethods`.

| Method | Params | Result |
| --- | --- | --- |
| `session.create` | `{ workspaceId, title? }` | `{ session }` |
| `session.list` | `{ workspaceId, cursor?, limit? }` | `{ sessions, nextCursor? }` |
| `session.get` | `{ sessionId }` | `{ session, activeTurn?, cursor }` |
| `session.messages.list` | `{ sessionId, cursor?, limit? }` | `{ messages, nextCursor? }` |
| `session.send` | `{ sessionId, clientRequestId, text, model }` | `{ turn, userMessage }` |
| `session.cancel` | `{ sessionId, turnId }` | `{ turn }` |
| `session.events` | `{ sessionId, afterSeq, limit? }` | `{ events, nextSeq, hasMore }` |

Draft semantics a future adapter must honor:

- **`session.get.cursor`** is the event sequence at the *same snapshot* as the
  returned metadata. It is not message history. Use it as the `afterSeq` of the
  first `session.events` poll.
- **`session.messages.list`** uses an opaque cursor that freezes the pagination
  upper bound at issue time, so a newer message cannot shift a page. Newest
  page first; items *within* a page are chronological. This cursor is
  independent of the event cursor, and the two must not be interchanged.
- **`session.send`** returns an *acceptance*, not a completed generation: the
  turn may still be queued or running. `clientRequestId` is a session-scoped
  idempotency key — an identical retry returns the same turn and message ids,
  the same key with different content is a conflict, only one turn is active per
  session at a time, and a disconnect does not cancel the turn. This draft
  retains idempotency records for the session's lifetime.
- **`session.cancel`** is idempotent and targets a specific turn. It returns a
  terminal turn when the turn already is terminal; because cancellation is
  cooperative, the acknowledgement may still report an active status until the
  terminal `turn.updated` event arrives.
- **`session.events`** is exclusive on `afterSeq`, ascending on the per-session
  positive safe-integer `seq`, and never skips an event. `nextSeq` is the last
  returned `seq`; on an empty page it retains the input `afterSeq`. `afterSeq:
  0` starts from the beginning of retained history *only if that history has not
  expired*. Paging defaults to 50 and caps at 200
  (`SESSION_PAGE_DEFAULT_LIMIT` / `SESSION_PAGE_MAX_LIMIT`); invalid paging
  arguments are rejected at the future adapter, not here.

### Recommended read flow

1. `session.get` once to obtain the session snapshot and its `cursor`.
2. `session.messages.list` to page backwards through history.
3. `session.events` with `afterSeq = get.cursor` to follow forward progress.

Apply events in sequence order, deduplicating by `(sessionId, seq)` and
upserting entities by id. When loading older history alongside events, only
fill missing entities; never overwrite an entity already refreshed by the
event stream. Timestamps are display metadata, not ordering tokens. If an
event cursor expires, discard that projection and restart the read flow.

## Events and error data

`SessionEvent` is discriminated on `type`: `session.updated` (carries
`session`), `turn.updated` (carries `turn`), `message.upserted` (carries
`message`). Each also carries `sessionId`, `seq`, `occurredAt`, and `type`.
Events are always whole-entity updates — there are no text deltas.

The same `SessionEvent` union is used by polling and by the **future**
`SessionNotifications` push contract (`'session.event'`). **No push or
subscription is implemented here**; polling is the only mechanism this draft
describes.

`SessionErrorData` is discriminated on `kind`: `session_not_found`,
`turn_not_found`, `session_busy`, `idempotency_conflict`, `cursor_expired`,
`cursor_ahead`. Only `session_not_found` has a numeric wire code today
(`-32003`). **The remaining numeric mapping is pending and must be defined
before runtime integration**; speculative codes were intentionally not
assigned. A consumer should discriminate on `kind`, and an expired or
ahead cursor means the client must resynchronize rather than retry blindly.

## Typed usage

```ts
import type {
  ProtocolResponse,
  RpcTypedRequest,
  SessionEvent,
  SessionMethods,
  SessionSendParams,
} from '@wrenyard/protocol'

// Params/results are inferred from the feature map, not restated:
type GetRequest = RpcTypedRequest<SessionMethods, 'session.get'>
//   -> { jsonrpc: '2.0'; method: 'session.get'; params: SessionGetParams; id: JsonRpcId }
type SendResponse = ProtocolResponse<'session.send'>
//   -> success carrying SessionSendResult, or an error response

const sendParams = {
  sessionId: 'ses_1',
  clientRequestId: 'cli_1',
  text: 'hello',
  model: { providerId: 'codebuddy', modelId: 'deepseek-v4.1-flash' },
} satisfies SessionSendParams
```

Root aliases keep the method <-> params relationship:

```ts
import type { ProtocolRequestUnion } from '@wrenyard/protocol'

function handle(request: ProtocolRequestUnion) {
  switch (request.method) {
    case 'session.get':
      // request.params is narrowed to SessionGetParams here
      return request.params.sessionId
    case 'session.send':
      // request.params is narrowed to SessionSendParams here
      return request.params.clientRequestId
    default:
      return undefined
  }
}
```

Typed sample payloads using `satisfies` live in `src/examples/session.ts` and
`src/examples/exec.ts`. They are not imported at runtime. The compiler has not
been run for this draft. JSON-RPC responses contain no method name: a client
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
`exec_client_unavailable`, `exec_cursor_expired`, `exec_feature_unknown`. As
with the session feature, **none of them has an assigned numeric wire code**;
the adapter must define the mapping.

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

Migrating an existing surface (for example the legacy `message.send` or the
desktop conversation snapshot) has three rules:

- **Preserve legacy wire names and fields.** Keep snake_case field names and
  existing method names exactly as they are on the wire; the DTOs are the
  adapter's target, not a wire rename.
- **Re-export during migration.** Keep legacy re-exports until every consumer
  has moved, then delete them in one deliberate change.
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

This package has no runtime wiring. Exec and provider handlers exist in the
daemon; session remains a design scaffold. No tests or typecheck were run for
the local refactor.
