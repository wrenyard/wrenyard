# @wrenyard/exec

Raw prompt execution: start one resolved agent client, follow its events under
explicit bounds, read snapshots, cancel.

`1.0.0-dev.35`, private, MIT, ESM. The package implements `ExecService`; the
wire shapes it exchanges live in `@wrenyard/protocol` under `src/exec`.

## Raw prompt vs structured task

These are two different products and the difference is the whole point of this
package.

A **structured task** is Foreman's unit of work. It carries a task id, a task
run, a dispatch snapshot, automatic routing, a repo-write lock, a queue
position, timeouts, retries, a persisted execution event log, and a taskgraph
it belongs to. Planning a structured task means resolving *which* client,
provider, model and mode should run it. Foreman owns all of that.

A **raw prompt execution** is what this package does. The caller has already
decided everything: client, upstream model, canonical model, provider, mode,
thinking level, working directory, resume session. It hands over a prompt and
gets back a run. Nothing here resolves a model, reads a catalog, consults the
database, holds a repo-write lock, queues, retries, or persists anything.

```
structured task                    raw prompt execution
───────────────                    ────────────────────
caller: "do this work"             caller: "run this prompt with codex on this
                                           exact model, in this directory"
resolves model / provider / mode   already resolved by the caller
queues, locks, retries             starts immediately, no queue, no retry
persisted execution events         in-memory bounded replay
task id, taskgraph membership      neither
survives a daemon restart          does not
```

The translation is one-directional and lossy by design: a structured task *can*
be lowered to a raw prompt execution once its plan is resolved, and the
execution cannot be raised back into a task. This package implements only the
lowered form. As stated in the repository architecture, `execution` owns
generic process invocation and `@wrenyard/clients` owns client choreography;
this package owns neither, it only binds one client run to a bounded, replayable
handle.

## API

```ts
import { ExecService } from '@wrenyard/exec'

const exec = new ExecService({ features })   // clients default to @wrenyard/clients

const handle = await exec.start({
  client: 'codex',
  provider: 'chatgpt',
  model: 'gpt-5-codex',
  mode: 'native',
  prompt: 'Summarize this workspace.',
  cwd: '/absolute/path',
  thinking: 'medium',
  features: ['browser'],
})

exec.get(handle.id)                 // ExecSnapshot | undefined
exec.events(handle.id, 0)           // readonly ExecEventEnvelope[]
await exec.cancel(handle.id)        // cooperative; resolves once settled
await exec.close()                  // cancels every live run
```

`ExecServiceOptions`:

| Option | Default | Meaning |
| --- | --- | --- |
| `clients` | `createAgentClients()` | agent clients by id |
| `features` | empty map | configured features by id |
| `defaultFeatures` | `[]` | feature ids used when a request names none |
| `maxRetainedEvents` | `2000` | per-execution retained event records |
| `maxRetainedBytes` | `4 MiB` | per-execution retained event bytes |
| `maxCompletedRuns` | `200` | terminal executions kept for later reads |

## One drain, many consumers

An agent session's `events` is a single-consumption async iterable. Returning it
to a caller would make the first consumer to iterate the only one that ever sees
those events. `ExecService` therefore iterates it exactly once, inside
`#consume`, appending every frame to a bounded `ExecReplayBuffer`; all reading
goes through `events(id, afterSeq)`. The handle's own `events` iterable is a
polling view over that same buffer, so a second reader never steals from the
first.

Terminal state is derived from what the drain loop observes:

- a `cancel()` request wins over everything, and reports `cancelled`;
- otherwise an `error` frame fails the run with that message;
- otherwise exit code `0` completes it and any other exit code fails it.

`session.result` is awaited only once the stream has ended, so a transport that
closes without an exit frame still settles boundedly rather than hanging.

## Bounds and gaps

Each execution's replay has two independent ceilings: `maxRetainedEvents` and
`maxRetainedBytes`. Both evict oldest-first. Because eviction is the only reason
a sequence number can be missing, a cursor older than retained history is a
*real* gap and is never silently skipped:

- `eventsWithGap(id, afterSeq)` returns `{ oldestRetainedSeq }` for that case,
  and `{ events, nextSeq }` otherwise;
- the protocol `exec.events` method carries the same distinction, and its
  adapter raises `exec_cursor_expired`.

Reading never evicts, so two reads with the same cursor return the same slice
while the run stays within its bounds. Terminal executions are retained by
count (`maxCompletedRuns`) and are the only entries ever dropped; live runs are
never pruned. `close()` cancels — it does not abandon — every live run, so no
agent child outlives the service.

## Features

A configured `ExecutionFeature` is `{ id, instructions?, mcpServers }`. A
request selects them by id; every id must be known *before* the client is
started, so an unknown id rejects the call without spawning anything.

- **MCP servers** from all selected features are merged into one map. Two
  selected features declaring the same server name is a hard error, not a
  preference: silently winning would hand the model a tool surface neither
  feature asked for.
- **Instructions** are appended to the raw prompt as numbered sections, in
  selection order. The caller's prompt is never rewritten or truncated.

Browser and computer feature *factories* are separate packages owned elsewhere;
this package only accepts the resulting feature records and does not define what
"browser" or "computer" means.

## Boundaries

This package:

- does **not** validate the JSON it receives from the wire (that is the
  adapter's job, at the transport boundary);
- does **not** resolve clients, providers, models, modes, thinking levels, or
  working directories;
- does **not** touch the task graph, database, catalog, repo-write locks, or
  quota;
- does **not** retry, back off, or open a circuit;
- exposes **no** process, environment, credential, executable-path, pid or raw
  stderr field on its snapshots.

`ExecSnapshot` carries ids, status, timestamps and a short error string, and
nothing else. The only free-form transport detail that reaches a consumer is the
normalized agent event record inside an `ExecEventEnvelope`.
