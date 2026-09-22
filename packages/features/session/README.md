# @wrenyard/session

Daemon-hosted conversation feature. Desktop presents its snapshots through
`@wrenyard/control-client/session`; the wire contract lives exclusively in
`@wrenyard/protocol/session`.

`SessionService` owns the current conversation context, summary preference and
revisioned snapshots. `SessionController` serializes backend transitions and
recovery. `backend.ts` composes the existing DSH client, process, managed profile
and workspace registry. The conversation engine retains independent sessions,
parallel turns, task ownership, streaming tools, usage/TPS, summaries and durable
restore behavior.

The host injects its configured workspace, state root, gateway snapshot and task
wait/cancel callbacks. The feature never reads a second daemon configuration or
imports Desktop/Electron. Gateway reads and owned task operations are in-process;
DSH MCP tools still use the daemon's public IPC surface.

Snapshots return a complete product projection and revision. An unchanged
revision may wait up to 1000ms; existing coalesced change notifications and
terminal flushes wake those callers. Desktop disconnection does not cancel turns.
The daemon closes the feature on shutdown. Backend recovery never resends prompts,
and model/credential changes wait until active turns settle before rebuilding.

The host retains the existing Desktop userData identity. Under that root, data
continues to use `dsh/`, `workspace-state/<sha256(workspace)>.json` and
`conversation-summary.json`, without changing document formats. DSH and the
managed `@wrenyard/dsh-shell` are package dependencies in the daemon release,
resolved from source or deployed package layouts rather than Electron resources.

The DSH backend runs under Node with `--expose-internals`, launcher options before
web options, and `--no-open`. It binds loopback; only product DTOs cross Desktop IPC.
The existing About runtime version is read through `session.backend`.

This migration was reviewed at source level only. Tests, builds and application
startup were not run as part of the requested local refactor.
