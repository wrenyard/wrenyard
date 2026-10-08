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

The summary-model preference is stored once per state root at
`<stateRoot>/session/summary-model.json` (canonical model id only, default
`deepseek-v4.1-flash`), never per workspace and never with a credential.

The daemon supplies its state root and configured workspace root. Desktop restart
does not interrupt turns; daemon shutdown drains them or interrupts with `shutdown`.
Old Desktop preview ledgers are not imported.

Attached files are stored outside the ledger at
`<stateRoot>/sessions/<sessionId>/files`; Task artifacts stay in their run
directory `<stateRoot>/artifacts/<runId>`. The ledger records them as `files`
events that carry metadata and paths only, never file bytes. `session.delete`
removes a session together with its files and run artifacts.

## Context

Every main reasoning request is the previous request with a segment appended. A
`cycle.started` event records each inference's turn, cycle, model, context
window and the previous request's input tokens. Volatile text sits in one short
closing message after the appended context, and the session id is the prompt
cache key. Main reasoning requests of one session are queued, so the history
stays linear.

Appends go through one serialized queue, so `seq` strictly increases per
session. Events are deep-frozen on the way in and timelines are copied out, so
callers cannot mutate state. The reader tolerates exactly one torn final JSONL
line: it truncates the fragment before further appends. Any other malformed line
is corruption and throws instead of being silently dropped.

## Modules

- `src/ledger.ts` — event types, JSONL storage, serialized durable append and
  the atomic derived index.
- `src/workspace.ts` — read-only file source, path validation, the frozen
  `WorkspaceSnapshot`, recent-doc scan and the project instruction chain.
- `src/views.ts` — prompt assembly, event rendering/escaping, layer statistics.
- `src/driver.ts` — the `ModelDriver` port and the OpenAI-compatible chat
  adapter: one stateless streaming completion with text, reasoning, native tool
  calls and usage.
- `src/responses-driver.ts` — the same port on the OpenAI Responses protocol.
- `src/inference.ts`, `src/inference-mode.ts` — transport selection. Auxiliary
  calls always use chat; a main reasoning call uses the one runtime its
  provider's declared protocols select (`openai_chat` before
  `openai_responses`).
- `src/calls.ts` — role→model resolution, model metadata, budget check,
  timeouts and `call` event writing.
- `src/actions.ts` — conversion of native `wy_action` tool calls into typed
  `read`, `write` and `dispatch` actions, task input validation and the action
  executors.
- `src/result-text.ts` — Task results laid out as Markdown text for the model.
- `src/media.ts` — attachment import (images resized and re-encoded once, text
  capped per file), in-place artifact description and preview reads.
- `src/documents.ts` — the document view of the ledger: one full entry, then
  unified diff hunks.
- `src/replies.ts` — progress replies, the final reply and the session title.
- `src/context-inspect.ts` — the forward-looking size of the next reasoning
  request (`session.context.inspect`).
- `src/engine.ts` — the work-turn state machine over the ports in
  `src/ports.ts`, with in-memory turn state in `src/runtime.ts` and streaming
  call snapshots in `src/live.ts`.
- `src/summary-model.ts` — the summary-model preference store and the settings
  snapshot projected from the live Gateway connection.
- `src/index.ts` — the composition root and the frozen `createSession` surface.

Dependencies point `engine → actions / calls / views / workspace / ledger`, and
`calls → driver`. `ledger` replay and `views` are pure functions.

## Actions

The main model declares actions through the single native `wy_action` tool;
there is no text marker parsing. Its output is replayed as an assistant message
with tool calls followed by tool results. Document writes are dispatched to the
`doc` Task.

## Provider notes

The chat driver speaks the gateway's OpenAI-compatible chat path
(`POST {openaiChatBaseUrl}/chat/completions`, `Authorization: Bearer <token>`).
Explicit Anthropic cache breakpoints are **not** supported on this path: the
request body is the plain OpenAI-chat shape with
`stream_options.include_usage`, and no provider-specific cache-control markers
are injected. Caching information is reported only through the upstream usage
frame (`prompt_tokens_details.cached_tokens`); absent fields stay absent.

The Responses driver speaks `POST {openaiResponsesBaseUrl}/responses`. The
system message becomes `instructions`, and the per-request closing message is
sent as a `developer` item so the implicit cache point stays at the end of the
appended context.
