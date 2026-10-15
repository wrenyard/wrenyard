# Bot mode configuration guide

Bot mode is Wrenyard's autonomous dispatcher: a daemon-owned agent that polls a
user-local inbox, confirms each request is real, dispatches it to its own session
and managed worktree, supervises progress, runs real-machine acceptance, delivers
one item at a time (rebase → accept → merge → push), completes the source item
and notifies you of the result. It replaces the coordinator loop that used to be
run by hand, and it is a generic capability: everything that touches your private
tools is configuration, never code. The design is specified in
[bot mode design note](../specs/2026-10-16-bot-mode.md); this guide is the
operator reference for configuring it.

## 1. Where the configuration lives

A bot's configuration is a JSON file at

```text
<configHome>/bots/<name>.json
```

`<configHome>` resolves as `WRENYARD_CONFIG_HOME` when that variable is set and
non-blank, otherwise the platform default config home (`~/.config/wrenyard`).
The configuration is user-local by design: it never lives in a workspace, in a
repository, or in the bot's database. The daemon stores only the file path and a
sha256 content hash; when you edit the file, the change takes effect on the next
tick after validation.

## 2. Annotated example

Every value below is a placeholder. Real model ids, real provider ids and real
adapter paths belong in your own file.

```jsonc
{
  "name": "dev-bot",                  // required; display name
  "mode": "dryRun",                   // "live" | "dryRun"; default "dryRun"

  "inbox": {                          // required; where work items come from
    "kind": "command",
    "argv": ["/path/to/inbox-adapter", "--filter", "bot"],
    "timeoutMs": 20000                // default 20000, max 300000
  },

  "notifier": {                       // required; where results are sent
    "kind": "command",
    "argv": ["/path/to/notify-adapter"],
    "env": { "NOTIFY_TOKEN": "${env:NOTIFY_TOKEN}" },  // resolved at run time
    "timeoutMs": 20000
  },

  "projects": [                       // required; at least one entry
    {
      "id": "example",                // must match a registered project
      "match": ["example"],           // item `project` hints that map here
      "merge": true,                  // default false
      "push": true,                   // default false
      "release": { "enabled": false } // default false; enabled is the only key
    }
  ],

  "routing": {                        // required; "default", "acceptance" and
                                      // "judgment" are mandatory
    "default":    { "provider": "<provider>", "model": "<model>", "reasoningEffort": "high" },
    "simple":     { "provider": "<provider>", "model": "<model>", "reasoningEffort": "medium" },
    "visual":     { "provider": "<provider>", "model": "<model>", "reasoningEffort": "high" },
    "acceptance": { "provider": "<provider>", "model": "<computer-use-model>", "reasoningEffort": "high",
                    "target": "<provider>/<model>:<client>" },
    "judgment":   { "provider": "<provider>", "model": "<strong-general-model>", "reasoningEffort": "high",
                    "target": "<provider>/<model>:<client>" }
  },

  "concurrency": {
    "maxActiveItems": 3,              // default 3, min 1
    "maxDispatchPerTick": 1           // default 1, min 1
  },

  "cadence": {
    "tickSeconds": 60,                // default 60, min 10
    "pollMinutes": 10                 // default 10, min 1
  },

  "quietHours": {                     // optional
    "timeZone": "UTC",                // any IANA time zone
    "start": "23:00",                 // HH:MM in that zone
    "end": "08:00",                   // end < start crosses midnight
    "defer": ["notify"]               // default ["notify"]; may be empty
  },

  "budgets": {
    "maxCorrections": 3,              // default 3
    "maxAcceptanceAttempts": 2,       // default 2
    "maxItemHours": 8,                // default 8
    "maxItemsPerDay": 20              // default 20
  }
}
```

Unknown keys are rejected, so a typo surfaces as a validation issue instead of a
silently ignored setting. Validation issues are returned, never thrown, by
`bot.config.validate { configPath }`.

## 3. Adapter protocol

An inbox or notifier adapter is a program (or, in the future, an MCP tool) that
exchanges one JSON object per call. The contract is exactly:

- one JSON request object on stdin, then stdin is closed;
- exactly one JSON object on stdout;
- exit status 0 for success, non-zero for failure.

The adapter runs without a shell (`argv` only, never a command string), the call
has a timeout, output is size-capped, and the whole process tree is killed when
the timeout or an abort fires.

### Inbox operations

| `op` | Request | Response |
| --- | --- | --- |
| `list` | `{ "op": "list" }` | `{ "items": [{ "id", "title", "body?", "project?", "url?", "updatedAt?" }] }` |
| `get` | `{ "op": "get", "id": "<id>" }` | `{ "item": { "id", "title", "body?", "project?", "open": <bool>, ... } }` or `{ "item": null }` |
| `complete` | `{ "op": "complete", "id": "<id>" }` | `{ "ok": <bool> }` |
| `annotate` | `{ "op": "annotate", "id": "<id>", "text": "<text>" }` | `{ "ok": <bool> }` |
| `release` | `{ "op": "release", "id": "<id>" }` | `{ "ok": <bool> }` |

`list` returns only the items the bot should consider: the filter (labels,
lists, tags) is the adapter's responsibility, not the bot's. Each item must carry
a stable `id`, a `title` and, for the bot to detect a changed request, the full
request `body`. The optional `project` hint maps an item to a configured project.

`annotate` and `release` are optional capabilities. `annotate` writes a note back
to the source item; `release` takes an item out of the bot's filter (for example
by removing a label). The bot never reads answers from the inbox — decisions come
from the Bot page (§9).

### Notifier operation

| `op` | Request | Response |
| --- | --- | --- |
| `send` | `{ "op": "send", "text": "<message>", "media": [{ "path", "kind": "image"\|"file" }] }` | `{ "ok": <bool>, "messageId"? }` |

`media` is optional and carries evidence artifacts (screenshots) produced by
acceptance.

Invalid responses are adapter errors: the reply is validated against the shape
above, and a mismatch is reported as `adapter.invalid_response` naming the
operation only.

## 4. Command adapters vs MCP adapters

- `command`: `{ "kind": "command", "argv": [...], "cwd"?, "env"?, "timeoutMs" }`.
  Implemented and recommended; it is what the demo scripts use.
- `mcp`: `{ "kind": "mcp", "server": { ... }, "tool": "<name>", "timeoutMs" }`.
  The request object is passed as tool arguments and the tool's JSON text result
  is parsed. **MCP adapters are not implemented yet** — configuring one produces
  an `adapter.unsupported` error until support lands.

## 5. Secrets and environment references

Secrets never go in the configuration file. An adapter `env` value may reference
the daemon's environment as `"${env:NAME}"`, either as the whole value or
embedded in a larger string:

```json
{ "env": { "NOTIFY_TOKEN": "${env:NOTIFY_TOKEN}" } }
```

References are resolved at execution time. A missing variable is an error that
names the variable only, and env values never appear in logs or error messages.

## 6. Timeouts and logging

- `timeoutMs` defaults to 20000 ms and is bounded at 300000 ms. A call that
  exceeds it is reported as `adapter.timeout` and its process tree is killed.
- Adapter error codes: `adapter.timeout`, `adapter.exit`, `adapter.invalid_json`,
  `adapter.invalid_response`, `adapter.env_missing`, `adapter.spawn`,
  `adapter.unsupported`.

**Logged:** the operation, the adapter kind and the executable basename, the
duration, the exit status, and item counts and ids.

**Never logged:** stdout/stderr bodies, `argv` values beyond the executable
basename, `env` values, request bodies, or their contents. Every log string
passes the daemon's redaction utilities before it is stored.

## 7. Minimal adapter skeletons

Adapt these to your own tools. Both read one JSON request from stdin and print
one JSON object on stdout.

### Inbox skeleton (Node)

```js
#!/usr/bin/env node
// Backing store: replace with your own (file, database, API).
const items = [{ id: 'example-1', title: 'Example request', body: 'What to do…', open: true }]

const request = JSON.parse(require('node:fs').readFileSync(0, 'utf8'))
const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)

switch (request.op) {
  case 'list':
    print({ items: items.filter((item) => item.open) })
    break
  case 'get': {
    const item = items.find((candidate) => candidate.id === request.id) ?? null
    print({ item: item === null ? null : { ...item, open: item.open === true } })
    break
  }
  case 'complete':
    items.find((item) => item.id === request.id).open = false
    print({ ok: true })
    break
  case 'annotate':
  case 'release':
    print({ ok: true })
    break
  default:
    process.stderr.write(`unknown op: ${request.op}\n`)
    process.exit(2)
}
```

### Notifier skeleton (Node)

```js
#!/usr/bin/env node
// Replace the sink with your own channel.
const request = JSON.parse(require('node:fs').readFileSync(0, 'utf8'))
if (request.op !== 'send') {
  process.stderr.write(`unsupported op: ${request.op}\n`)
  process.exit(2)
}
sendMessage(request.text, request.media ?? []) // your implementation
process.stdout.write(`${JSON.stringify({ ok: true, messageId: 'example' })}\n`)
```

## 8. Routing classes

`routing` maps an item class to a model. `bot-verify` assigns the class when it
confirms a request is real; `default`, `acceptance` and `judgment` are required,
and any other key you add is a class your inbox or verification can name (for
example `simple`, `visual`).

- `default` (and any custom class): the model for dispatched work sessions.
- `judgment`: the model for the read-only `bot-verify` and `bot-review` runs.
  Recommended: a strong general model.
- `acceptance`: the model for the `test` task that drives the browser or desktop
  operation components. Recommended: a model strong at computer use.

Each entry carries `provider`, `model` and `reasoningEffort` (used for session
turns) and may carry an optional `target`, a registered run target of the form
`<provider>/<model>:<client>`. Task runs (verify, review, acceptance) use
`target` as an explicit selection; without it they use automatic routing, and the
bot logs `routing.auto` once per bot. Session turns always use
provider/model/reasoningEffort. A target that is not registered and available
parks the item rather than guessing.

## 9. Dry run vs live

`mode` gates every outward effect:

| Effect | `dryRun` | `live` |
| --- | --- | --- |
| Verify, dispatch, sessions, supervision, acceptance | run for real | run for real |
| Rebase inside the worktree | runs for real | runs for real |
| `merge`, `push` | recorded as would-do only | performed when the project policy allows |
| `inbox.complete`, `annotate`, `release` | recorded only | performed |
| `notify` | recorded only, including the would-be text | sent |
| release procedure | recorded only | performed when enabled |

Item states advance identically in both modes, with a `dryRun` mark, so a dry run
is a faithful rehearsal. Switching a bot from `dryRun` to `live` does not replay
the effects recorded during the dry run. Dry run is the default and is the right
first setting.

## 10. Quiet hours and deferral

When `quietHours` is configured and the current time (in `timeZone`) falls inside
the window, the actions listed in `defer` (default `notify`) are held and sent
once quiet hours end — still one message per item. Parked questions are deferred
the same way unless the item is marked urgent. Windows whose `end` is earlier
than their `start` cross midnight.

## 11. Operation components for acceptance

Acceptance exercises the real surfaces through Wrenyard's managed operation
components (Settings → 操作组件):

- `browser` (agent-browser CLI) for renderer checks over the real Desktop UI;
- `desktop` (Cua Driver) for native surfaces: menus, tray, dock, dialogs.

Before starting acceptance the bot refreshes the components its plan requires and
reads their state. A component that is not `ready` (`not-installed`,
`installing`, `needs-authorization`, `failed`, `unsupported`, `disabled`) parks
the item with the component name, its state and the host, and raises one
escalation — the bot never silently downgrades a check. The `desktop` component
has one owner per host, so desktop acceptance runs are serialized across all
projects; a busy desktop leaves the item in `accepting` and it retries on a later
tick. The builtin `test` task selects a component through its `capability` input
(`browser-use` → `browser`, `computer-use` → `desktop`).

## 12. Running the demo

`node tools/bot-demo/run.mjs` runs one bot end to end in dry-run mode against a
disposable, fully isolated daemon: its own temp state home, config home, IPC
socket, workspace and git project. Inbox and notifier are fake command adapters,
[`fake-inbox.mjs`](../../tools/bot-demo/fake-inbox.mjs) (a JSON file) and
[`fake-notifier.mjs`](../../tools/bot-demo/fake-notifier.mjs) (an append-only log
file). The real config and state homes are never written.

```bash
node tools/bot-demo/run.mjs --session-model <provider>/<model>/<effort> \
  [--judgment-target <provider>/<model>:<client>] \
  [--acceptance-target <provider>/<model>:<client>] \
  [--provider-config-from <dir>] \
  [--timeout-minutes 30] [--keep]
```

| Flag | Meaning |
| --- | --- |
| `--session-model` | Required. `<provider>/<model>/<effort>` for the session turns. |
| `--judgment-target` | Optional explicit run target for `bot-verify`/`bot-review`. |
| `--acceptance-target` | Optional explicit run target for acceptance. |
| `--provider-config-from` | Copy only the provider credential/runtime subtrees the daemon needs for model access into the temp config home; contents are never printed. |
| `--timeout-minutes` | Overall wall-clock budget; default 30. |
| `--keep` | Keep the temp root instead of deleting it. |

The driver seeds one open item, registers the demo project, validates the config,
creates and starts the bot, then ticks it while printing state transitions, log
codes and health until the item reaches a terminal state or the budget runs out.
Finally it asserts four things and exits 0 only when all four hold:

1. the item reached `completed` (otherwise the exact state, `item.error` and the
   last log codes are reported);
2. the fake inbox item is still open — a dry run never completes it;
3. the fake notifier log file is empty or absent — a dry run never notifies;
4. the demo project's `main` head is unchanged — a dry run never merges.

It then prints the `bot.health` snapshot and stops the daemon gracefully (IPC
`daemon.shutdown`, then `SIGTERM`, then `SIGKILL` after 15 s).

## 13. Watching an 8-hour unattended run

The acceptance criterion for Bot mode as a whole is at least **8 hours of
continuous unattended operation on the installed app**. `bot.health { botId }`
is what makes that measurable; watch these numbers on the Bot page:

| Field | What a healthy 8-hour run looks like |
| --- | --- |
| `uptimeSince` | Older than the intended run window; it resets only when the host restarts. |
| `ticks` | Keeps advancing at the configured `cadence.tickSeconds`. |
| `lastTickAt` | Recent — a stale value means the host stopped ticking. |
| `tickLagMs` (`last`, `max`) | `last` near the cadence, `max` bounded; a growing `max` is the first sign of overload. |
| `itemsByState` | Items move forward; a growing pile of items in one state shows where they stalled. |
| `stepsFailed24h` | Zero, or explained by the log. |
| `adapterErrors24h` | Zero, or explained by the log; repeated adapter errors are escalated once per code per hour. |
| `escalations24h` | Each entry should map to a real condition you know about. |
| `lastError` | Absent, or an error you have already seen and accepted. |
| `host` | The device and daemon the bot runs on (`hostname`, `platform`, `arch`, `daemonVersion`, `mode`). |
| `components` | Every component the acceptance plans need is `ready`. |

The 24-hour counters are computed from persisted step and log rows, so they stay
correct across daemon restarts. A run counts as continuous when ticks advance
without gaps beyond the cadence, `tickLagMs` stays bounded, and every failure
appears both in the counters and in the log.

## Related

- Design note: [bot mode](../specs/2026-10-16-bot-mode.md)
- Demo drivers: [`tools/bot-demo/run.mjs`](../../tools/bot-demo/run.mjs),
  [`fake-inbox.mjs`](../../tools/bot-demo/fake-inbox.mjs),
  [`fake-notifier.mjs`](../../tools/bot-demo/fake-notifier.mjs)
