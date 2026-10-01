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

Appends go through one serialized queue, so `seq` strictly increases per
session. Events are deep-frozen on the way in and timelines are copied out, so
callers cannot mutate state. The reader tolerates exactly one torn final JSONL
line: it truncates the fragment before further appends. Any other malformed line
is corruption and throws instead of being silently dropped.

## Modules

- `src/ledger.ts` — event types, JSONL storage, serialized durable append,
  atomic derived index, and the pure `replayLedger` / `applyLedgerEvent` fold.
- `src/workspace.ts` — read-only file source, path validation, the frozen
  `WorkspaceSnapshot`, recent-doc scan and the project instruction chain.
- `src/views.ts` — prompt assembly, event rendering/escaping, layer statistics.
- `src/driver.ts` — one streaming OpenAI-chat completion against the gateway.
- `src/calls.ts` — role→model resolution, model metadata, budget check,
  timeouts and `call` event writing.
- `src/actions.ts` — `<wy-action>` streaming splitter, parsing and the three
  action executors.
- `src/engine.ts` — the work-turn state machine over the ports above.
- `src/summary-model.ts` — the summary-model preference store and the settings
  snapshot projected from the live Gateway connection.
- `src/index.ts` — the composition root and the frozen `createSession` surface.

Dependencies point `engine → actions / calls / views / workspace / ledger`, and
`calls → driver`. `ledger` replay and `views` are pure functions.

## Provider notes

The MVP driver speaks the gateway's OpenAI-compatible chat path
(`POST {openaiChatBaseUrl}/chat/completions`, `Authorization: Bearer <token>`).
Explicit Anthropic cache breakpoints are **not** supported on this path: the
request body is the plain OpenAI-chat shape with
`stream_options.include_usage`, and no provider-specific cache-control markers
are injected. Caching information is reported only through the upstream usage
frame (`prompt_tokens_details.cached_tokens`); absent fields stay absent.
