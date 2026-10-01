# @wrenyard/protocol

IPC conversation IDL plus the pure static update-feed contract. Private, MIT,
ESM, zero runtime dependencies. The canonical daemon IPC protocol
version is `2` (`WRENYARD_PROTOCOL_VERSION` in `@wrenyard/control-client`): the
version is negotiated through the `health.ping` handshake, and an older client
fails closed instead of talking to a daemon whose session surface it cannot
address.

> **These types DO NOT VALIDATE incoming JSON.**
>
> Nothing in this package parses, checks, sanitizes, dispatches, or stores a
> message. A value typed as `ExecSnapshot` is a compile-time claim about
> a wire shape, not a runtime guarantee. **Runtime validation stays at the
> adapter** on the transport boundary. Treat every payload crossing the wire as
> untrusted.

## Boundaries

This package is an isolated protocol shape. It deliberately does **not**
contain, and must not grow, any of the following:

- runtime validators or type guards for the IPC DTOs (schema generation is a
  future design choice; the one deliberate exception is the dependency-free
  `./update-feed` module below, which validates the static update feed)
- request handlers, routers, registries with runtime entries, or dispatch
- sockets, pipes, connections, reconnection, or transport of any kind
- persistence, storage, caching, or session lifecycle management
- native client types (`node:*`, Electron, DOM), or any Node/Electron import
- desktop UI state, view models, or presentation projections
- runtime dependency on any Wrenyard business package

It also does not implement the session engine: `@wrenyard/session` owns the
append-only session ledger, the workspace documents and recovery, and declares
the product session DTOs it projects. This package no longer declares a
`./session` subpath; the daemon's `session.*` wire surface is owned by
`apps/daemon/lib/protocol` and only mirrors the JSON-RPC envelope shape here.

### Relationship to existing code

This package is **not** the daemon session surface. The `session.*` conversation
API lives on the daemon IPC and is built over `@wrenyard/session`; its
params/results are declared with the daemon-owned schemas under
`apps/daemon/lib/protocol`, not here. The JSON-RPC envelope shape is mirrored so
an adapter can carry both, and no daemon wire type is imported here.

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
  exec/
    types.ts            ExecSnapshot + ExecEventEnvelope (no process/env fields)
    methods.ts          the four method param/result pairs + ExecMethods
    errors.ts           ExecErrorData discriminated by kind
    index.ts
  examples/
    exec.ts             static typed example data (satisfies, no casts)
  update-feed.ts        pure static update-feed contract: schema/asset/digest
                        validation, canonical asset names, SemVer ordering,
                        channel inference and document URL construction
README.md
package.json
tsconfig.json
```

`package.json` exports the source directly: `.` -> `src/index.ts`,
`./common` -> `src/common/index.ts`,
`./exec` -> `src/exec/index.ts`, `./provider` -> `src/provider/index.ts`,
`./update-feed` -> `src/update-feed.ts`.
There is intentionally **no build pipeline**; a `typecheck` script is declared
but nothing in this task runs it.

## Canonical session surface

The daemon IPC exposes the append-only session ledger as seven `session.*`
methods. Their params/results are declared by the daemon-owned schemas in
`apps/daemon/lib/protocol/methods/session.mts`; `@wrenyard/session` is the
engine behind them.

| Method | Params | Result |
| --- | --- | --- |
| `session.list` | *none* | `{ sessions: SessionSummary[] }` |
| `session.create` | *none* | `{ sessionId }` |
| `session.send` | `{ sessionId, text, model }` | `{ turn }` |
| `session.interrupt` | `{ sessionId, turn }` | *none* |
| `session.events` | `{ sessionId, afterSeq, limit?, waitMs?, live? }` | `{ events, lastSeq, live? }` |
| `session.summary.settings` | *none* | `SummarySettingsSnapshot` |
| `session.summary.save` | `{ canonicalModel }` | `SummarySettingsSnapshot` |

Contract semantics the adapters honor:

- **The ledger is the source of truth.** `session.events` returns the durable
  events after `afterSeq`; a call's streaming text and reasoning are a separate
  in-memory snapshot carried only when `live` is set.
- **`session.events` is a bounded long-poll.** With a positive `waitMs` (never
  more than 1000ms) an empty page waits for the next durable append or live
  update and still returns the complete page since the cursor.
- **`session.interrupt`** addresses one admitted turn by number; only that turn's
  own execution branch and its owned task runs are stopped, so parallel turns
  are unaffected.
- **`session.summary.settings` / `session.summary.save`** own the summary-model
  preference. `settings` projects the persisted canonical model plus every
  ordinary-LLM candidate the live local model Gateway can serve; `save` persists
  the canonical model and returns the re-projected snapshot.
- Every session method is IPC-only: the HTTP and MCP transports never execute a
  session action.

No notification channel is part of the composed protocol yet.

## Typed usage

```ts
import type {
  ProtocolResponse,
  RpcTypedRequest,
  ExecMethods,
  ExecStartParams,
} from '@wrenyard/protocol'

// Params/results are inferred from the feature map, not restated:
type StartRequest = RpcTypedRequest<ExecMethods, 'exec.start'>
//   -> { jsonrpc: '2.0'; method: 'exec.start'; params: ExecStartParams; id: JsonRpcId }
type StartResponse = ProtocolResponse<'exec.start'>
//   -> success carrying ExecStartResult, or an error response

const startParams = {
  client: 'codebuddy',
  model: 'deepseek-v4.1-flash',
  prompt: 'hello',
  cwd: '/workspace',
} satisfies ExecStartParams
```

Root aliases keep the method <-> params relationship:

```ts
import type { ProtocolRequestUnion } from '@wrenyard/protocol'

function handle(request: ProtocolRequestUnion) {
  switch (request.method) {
    case 'exec.start':
      // request.params is narrowed to ExecStartParams here
      return request.params.prompt
    case 'exec.get':
      // request.params is narrowed to ExecGetParams here
      return request.params.id
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
   export interface ProtocolMethods extends ProviderMethods, TaskgraphMethods {}
   export interface ProtocolNotifications extends TaskgraphNotifications {}
   ```

   Conflicting inherited definitions are type errors; features never override
   one another. Keep wire names globally unique. The
   root request/response/notification unions then pick the feature up
   automatically — no per-feature alias file is needed.
3. Add subpath exports in `package.json` if the feature should be importable
   on its own (`./<feature>`).

The wire name is the contract: once a method is published its name and fields
stay stable, and a change in shape is a new method (or a protocol-version bump),
never a silent rename. The canonical session surface was one deliberate
exception: it replaced the retired conversation and versioned-session APIs
with the ledger-backed `session.*` methods exactly once, coordinated with
`WRENYARD_PROTOCOL_VERSION` `2`, so a stale client fails closed at the handshake
instead of misreading the new shape.

Runtime stays outside protocol: feature services may consume these type-only
contracts. Transport adapters own validation and numeric error-code assignment;
protocol never imports the feature implementation.

## Provider surface

`@wrenyard/protocol/provider` declares `provider.list`, `provider.configure`
and `provider.quota`. The first two preserve their existing wire shapes.
`provider.quota` accepts `{ forceRefresh?: boolean }` and returns
`{ providers: ProviderQuotaSnapshot[], fetchedAt: number }`. Each quota row
preserves status, windows, balances and reset metadata; `fetchedAt` is epoch
milliseconds. It does not require the retired CLI `display_line` field.

The daemon validates and dispatches these methods over local IPC to
`@wrenyard/provider-service`. Desktop and CLI use the same quota source.

## Static update feed

`@wrenyard/protocol/update-feed` is the one runtime module in this package. It is
a pure, dependency-free contract for the static feed published on the `updates`
branch and consumed by Desktop. It performs no I/O and has no import side
effects, so it bundles into the Desktop main process unchanged.

Feed layout (the base URL defaults to the `updates` branch and is overridable
with `WRENYARD_UPDATE_BASE_URL`):

```
<base>/dev.json             channel head for prereleases
<base>/stable.json          channel head for stable releases
<base>/versions/<v>.json    immutable per-version snapshot
```

Document schema `wrenyard.update.v1`:
`{ schema_version, version, published_at, assets: [{ name, url, sha256 }] }`.

Exports:

| Export | Purpose |
| --- | --- |
| `UPDATE_FEED_SCHEMA_VERSION` | schema id carried by every published document |
| `PlatformTriplet` | host triplets that publish Desktop assets (`darwin-arm64`, `win32-x64`) |
| `isSemver`, `compareVersions`, `normalizeVersion` | SemVer validation and numeric ordering |
| `desktopAssetStem`, `installerAssetName`, `updateAssetName` | canonical Desktop asset names per version and triplet |
| `channelForVersion`, `channelDocumentUrl`, `updateDocumentUrl`, `resolveUpdateBaseUrl` | channel inference and URL construction |
| `parseUpdateFeedJson` | validation and host-asset resolution |

`parseUpdateFeedJson(text, { triplet, expectedVersion?, channel? })` validates the
schema, that `version` is valid SemVer (and matches `expectedVersion` when
given), that both the installer and update assets for the host triplet exist,
and that every digest is 64 hex. It returns the document, the resolved channel
and the two assets. Asset URLs are deliberately **not** required to be canonical
GitHub download URLs: the URL and digest come from the same document, so the
check adds no integrity guarantee while it would prevent local end-to-end tests
from serving the feed over a local HTTP server. Integrity is the sha256.

## Implementation status

The session contract is the real, implemented surface: `@wrenyard/session` owns
the append-only ledger, and the daemon's `session.*` IPC methods project and
mutate it against the schemas declared in `apps/daemon/lib/protocol`. Exec and
provider handlers also exist in the daemon. The protocol package itself has no
IPC runtime wiring and never imports a feature implementation; its only runtime
module is the pure, dependency-free `./update-feed` contract above.
