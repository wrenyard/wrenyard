# @wrenyard/session-jsonl

Durable JSONL + `fsync` + `index.json` persistence adapter implementing
`@wrenyard/session`'s `SessionPersistencePort`.

## Storage Layout

Under `<stateRoot>/session/<sha256(workspaceRoot)>/`:

- `sessions/<sessionId>.jsonl`: append-only, one JSON-serialized `LedgerEvent`
  per line (`fsync`ed on every append). A torn final line (trailing fragment
  without a closing newline) is truncated before any subsequent append; any
  malformed complete line throws `SessionCorruptedError`.
- `index.json`: derived session metadata cache (`sessionId`, `title`,
  `manualTitle`, `archived`, `pinned`, `lastTurn`, `lastSeq`, `pendingTurns`,
  `bytes`), reconciled at startup by file `stat` only without parsing JSONL
  bodies.

## Features

- **3-cap LRU timeline cache** (`16` sessions, `64 MiB`, `60,000` events) with
  write pinning so in-flight appends never observe an evicted timeline.
- **Single-writer storage handles** (`JsonlStorageHandle`) enforcing read-only
  and closed-handle guards plus `SessionAlreadyOwnedError` exclusion.
- **Transitional event normalization** (`normalizeStoredEvent`) mapping
  historical ledger records onto the current `@wrenyard/protocol/session` model.
- **`beforeAppend` hook & exclusive queue** enabling atomic document-authority
  snapshots without coupling storage to workspace document logic.
