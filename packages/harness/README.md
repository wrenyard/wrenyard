# @wrenyard/harness

The Wrenyard conversation harness layers product orchestration, XML prompt projection, auxiliary workflows, and workspace tools on top of `@wrenyard/session`, `@wrenyard/loop`, `@wrenyard/ai`, and `@wrenyard/protocol/session`. It keeps persistence pluggable via `@wrenyard/session`'s `SessionPersistencePort` and defaults to in-memory persistence unless the caller supplies a durable backend (such as `@wrenyard/session-jsonl`).

## Module Map

- `src/index.ts`: Composition root (`createSession`, `createHarnessSession`, `createDocumentAuthority`, `createWorkspaceMemory`, `createCallRunner`) and public types/constants.
- `src/session-status.ts`: Browser-safe status-dot and error-tooltip derivation (`./session-status` subpath, importing only protocol summary types).
- `src/events.ts`: Harness context event set (`CONTEXT_EVENT_TYPES`), `turnId` / `stepId` formatters, `collectSessionFiles`, `contextImageFiles`, `LedgerPage`, and `@wrenyard/protocol/session` event re-exports.
- `src/types.ts`: Model roles (`AUXILIARY_ROLE_ORDER`, `AuxiliaryCallRole`, `CallRole`) and route requirements (`ROLE_ROUTE_REQUIREMENTS`).
- `src/ports.ts`: Host/session contracts (`SessionHost`, `HarnessHost`, `Session`, `HarnessSession`, `AgentToolPort`, `EnginePorts`, `SessionCallHost`, `HarnessLedgerPort`).
- `src/errors.ts`: Shared error formatting helper (`messageOf`).
- `src/tools/`: Workspace document versioning and unified diffs (`documents.ts`), atomic workspace document authority (`document-commit.ts`), workspace memory writes (`memory-write.ts`), safe workspace document catalog (`workspace-files.ts`), and media/attachment preview store (`media-store.ts`).
- `src/context/`: Pure XML event rendering (`render.ts`), orchestrator prompt assembly (`prompt.ts`), cold-event token reduction (`reduction.ts`), compaction summarization (`compaction.ts`), forward-looking context inspection (`inspect.ts`), workspace snapshot capture (`snapshot.ts`), and `@wrenyard/session` projector adapter (`projector.ts`).
- `src/auxiliary/`: Declarative auxiliary definitions (`definitions.ts`), dispatch compiler (`dispatch.ts`, `dispatch-result.ts`), document/vcs/project/todo/search/memory actions, reply writer (`reply.ts`), title/status/suggestion auxiliaries, and auxiliary runner (`runner.ts`, `shared.ts`).
- `src/drivers/`: Turn/session harness runtime state (`runtime.ts`), action execution & ordering (`executor.ts`), resident sub-session adapter (`auxiliary.ts`), orchestrator loop over `@wrenyard/loop` (`orchestrator.ts`), and bot tool loop (`bot.ts`).
