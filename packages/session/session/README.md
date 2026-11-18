# @wrenyard/session

Pure conceptual session kernel providing append-only timelines, surface
shadowing, fork/tail-recovery primitives, memoized context projections,
send/recovery latches, live streaming hubs, and persistence/driver ports.

## Architecture

`@wrenyard/session` is intentionally runtime-agnostic and dependency-free:

- **Zero external I/O**: `src/` contains zero `node:*` imports and zero `@wrenyard/*`
  package imports. Durable storage and execution loops are injected through
  `SessionPersistencePort` and `SessionDriverPort` (with an internal
  `MemorySessionPersistence` default for standalone use).
- **Append-only timeline**: Committed events receive strictly monotonic sequence
  numbers (`seq`), are losslessly JSON-validated and deep-frozen on commit, and
  can be paged by binary search without copying the backing array.
- **Surface shadowing without mutation**: Replacement events (`surfaceOp` or
  projector `replaceRange` hooks) shadow older sequence ranges on derived
  surface views while keeping the durable timeline immutable.
- **Tail repair & fork seeding**: Pure inspection (`repairInterruptedTail`,
  `buildForkSeed`) closes dangling turns, steps, actions, and spans in
  child-first order on shutdown recovery or branch fork.
- **Single-writer session coordination**: `SessionManager` enforces single-flight
  recovery, single-writer handle reuse per resident `ManagedSession`, synchronous
  send/recovery latches, deletion tombstones, idle eviction, and cross-manager
  peer interrupts.
