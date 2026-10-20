# @wrenyard/session

Context-ledger conversation core, hosted by the daemon through injected in-process
ports. Desktop relays `session.*` IPC and ledger events to the React page.
The feature does not depend on DSH or Desktop.

## State architecture

The ledger is the only durable state. Everything else — turn stages, running
actions, budget counts, titles — is a pure fold over the timeline.

Under `<stateRoot>/session/<sha256(workspaceRoot)>/`:

- `sessions/<sessionId>.jsonl` — one event per line, appended durably (`fsync`).
- `index.json` — the session list (`sessionId`, `title`, `createdAt`,
  `updatedAt`), written atomically and derived from the timelines.

Auxiliary calls select a Gateway route freshly for each role using the shared Task routing evidence and weights. Role requirements and ordered effort preferences live in `src/model/roles.ts`; each span records the route, rank, ordered candidates, requested effort and the effort actually sent.

The daemon supplies its state root and configured workspace root. Desktop restart
does not interrupt turns; daemon shutdown drains them or interrupts with `shutdown`.
A daemon restart does not resume interrupted turns. Old Desktop preview ledgers
are not imported.

Attached files are stored outside the ledger at
`<stateRoot>/sessions/<sessionId>/files`; Task artifacts stay in their run
directory `<stateRoot>/artifacts/<runId>`. The ledger records them as `files.attached`
events that carry metadata and paths only, never file bytes. `session.delete`
removes a session together with its files and run artifacts.

## Ledger events

Every event has one timestamp and names its place by ids: a start event names
its `parent`, the matching finish repeats its `id`, and content events name a
`parent`. There are three families:

- **Structure** — `session.created`, `turn.*`, `step.*` and `action.*`: what the
  session decided to do. A turn is one user message; each step is one main
  reasoning request and the actions it declared.
- **Execution** — `span.started`, `span.context` and `span.finished`: what
  actually ran. A span is one reasoning request, one whole auxiliary task or one
  dispatched agent task, with its request facts, route, usage and timing. Spans
  never enter the model context.
- **Content** — reasoning text, recalled memories, found and loaded documents,
  attached files, workspace changes, replies and system notices: the material
  the model and the user read.

`src/ledger/events.ts` declares which event types may enter the rendered model
context.

## Context

Every main reasoning request is the previous request with a segment appended. A
`step.started` event records each step's model, context window and the previous
request's input tokens, and is rendered as that step's info line, so per-request
facts are part of the append-only context. Volatile text sits in one short
closing message after the appended context, and the session id is the prompt
cache key. Main reasoning requests of one session are queued, so the history
stays linear.

Appends go through one serialized queue, so `seq` strictly increases per
session. Events are deep-frozen on the way in and timelines are copied out, so
callers cannot mutate state. The reader tolerates exactly one torn final JSONL
line: it truncates the fragment before further appends. Any other malformed line
is corruption and throws instead of being silently dropped.

## Modules

- `src/ledger/` — event types (`events.ts`), JSONL storage, serialized durable
  append and the atomic derived index (`store.ts`).
- `src/workspace.ts`, `src/snapshot.ts` — read-only file source, path
  validation, the frozen `WorkspaceSnapshot`, recent-doc scan and the project
  instruction chain.
- `src/reasoning/` — the main reasoning request and its prompt layers
  (`prompt.ts`), the one native `wy_action` tool and its parser (`tool.ts`), and
  the router from a parsed action to its auxiliary task (`actions.ts`).
- `src/auxiliary/` — the cheap-model roles: `search`, `dispatch`, `document`,
  `vcs` and `project` actions, plus `reply`, `title`, `memory` search, `status`
  judgement and the next-prompt `suggestion`.
- `src/loop/` — the shared multi-round tool loop every auxiliary task runs on,
  and span recording (`span.ts`).
- `src/model/` — auxiliary role requirements, model metadata and request
  budgets.
- `src/transport/` — one inference port over the Gateway with the Chat
  Completions, Responses and Anthropic Messages adapters, shared SSE reading,
  error classification and the bounded retry and circuit policy.
- `src/turn/` — session lifecycle (`engine.ts`), the work-turn and step loop
  (`turn.ts`), in-memory turn state (`runtime.ts`) and streaming snapshots of
  running reasoning calls (`live.ts`).
- `src/context/` — event rendering and the forward-looking size of the next
  reasoning request (`session.context.inspect`).
- `src/media.ts`, `src/documents.ts`, `src/memory-write.ts` — attachment import,
  the document view of the ledger and durable memory writes.
- `src/index.ts` — the composition root and the frozen `createSession` surface.

## Durable workspace memories

The existing terminal reply call may carry optional durable memory candidates.
The candidates are saved only after a nonempty `reply.sent` is durable and
before the `turn.finished` row, and only for a successful final reply that is
not a standalone question. Progress, failed, interrupted, empty and ask replies
save nothing. No extra model call is made.

Save only user-stated preferences or corrections, confirmed project decisions
and verified facts useful in later sessions; never transcripts, task status,
secrets or guesses. Each `memories/*.md` file has YAML frontmatter with `name`,
`description` and `metadata.type` (`user`, `feedback`, `project` or
`reference`), then the fact as Markdown. An upsert matches the frontmatter
`name`, keeps the existing filename, requires the exact previous body to change
an existing fact, and skips logically unchanged content. No existing memory is
deleted or renamed, and unrelated names or filenames are never overwritten.
`memories/INDEX.md` keeps one link line per memory, with unrelated entries left
alone. Retrieval reads the current index, so a save is visible to the next
search. Every real file or index write appends a visible `system.info` /
`memory.saved` record; a failure appends a `system.warning` / `memory.write`
without discarding the accepted reply.

## Actions

The main model declares actions through the single native `wy_action` tool;
there is no text marker parsing. Each call names an action type and a
natural-language intent:

| Action | What its auxiliary task does |
| --- | --- |
| `search` | Find and load workspace documents and memories for the model. |
| `dispatch` | Compile the intent into one Task run (task, project, input) and start it. |
| `document` | Create or edit a workspace document or a project `AGENTS.md`. |
| `vcs` | Inspect, commit, push or pull the workspace or a project. |
| `project` | Register projects and manage their worktrees. |

A host may also expose native tools by name (bots use this for their `session`,
`todo` and `message` tools); those calls are recorded as `tool` actions. The
model's output is replayed as an assistant message with tool calls followed by
tool results.

## Provider notes

A call uses the first protocol the model declares, in the order Chat
Completions, Responses, Anthropic Messages.

The chat adapter speaks the gateway's OpenAI-compatible chat path
(`POST {openaiChatBaseUrl}/chat/completions`, `Authorization: Bearer <token>`).
Explicit Anthropic cache breakpoints are **not** supported on this path: the
request body is the plain OpenAI-chat shape with
`stream_options.include_usage`, and no provider-specific cache-control markers
are injected. Caching information is reported only through the upstream usage
frame (`prompt_tokens_details.cached_tokens`); absent fields stay absent.

The Responses adapter speaks `POST {openaiResponsesBaseUrl}/responses`. The
system message becomes `instructions`, and the per-request closing message is
sent as a `developer` item so the implicit cache point stays at the end of the
appended context.

The Messages adapter speaks `POST {anthropicBaseUrl}/messages`. System messages
become the top-level `system` field and every declared tool becomes an
`input_schema` tool.
