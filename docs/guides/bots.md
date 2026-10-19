# Bots and routines

A bot is an agent that keeps working without you at the keyboard. Each bot has
its own instructions, its own conversation, and an explicit set of tools. It is
woken by a routine, by a message from you or another bot, or by a work session
it started finishing a turn. Bots appear on the **机器人** (Bots) page of the
desktop app.

> The **旧版机器人** (legacy bot) page is the earlier deterministic inbox
> dispatcher. It still works and is documented in the
> [legacy bot mode guide](bot-mode.md); new automation should use the bots
> described here.

## Define a bot

A bot is one JSON file:

```text
<config root>/bot-agents/<id>.json
```

The config root is `WRENYARD_CONFIG_HOME` when set, otherwise
`~/.config/wrenyard` (the same directory that holds the rest of your
Wrenyard settings). The daemon checks the directory every few seconds, so
adding, editing or removing a file takes effect without a restart. A file that
does not validate disables only that bot, and the Bots page shows the error.

```json
{
  "id": "reviewer",
  "name": "Reviewer",
  "instructions": "Every morning, check the open todos of project aurora. Open a work session for each item that needs code changes and report a short summary to the release bot.",
  "tools": { "session": true, "todo": true, "message": true },
  "routines": [
    {
      "name": "morning-review",
      "prompt": "Check the open todos of project aurora.",
      "intervalMinutes": 1440,
      "deliver": "bot:release"
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `id` | Required. Must equal the file name; lowercase letters, digits and `-`, at most 32 characters. |
| `name` | Display name; defaults to the id. |
| `enabled` | `false` puts the bot out of service without deleting the file. Defaults to `true`. |
| `instructions` | Text added to the bot's fixed system prompt: its job, its project, how to report. |
| `tools` | Which tools the bot may call (see below). Nothing is enabled by default, so a bot without tools can only answer in text. |
| `routines` | Routines this file declares (see below). |

Unknown fields are rejected, so typos surface as an error instead of being
ignored.

## Tools

| Tool | What the bot can do |
| --- | --- |
| `session` | List, create and message work sessions, and interrupt a running turn. A work session is a full Wrenyard conversation: it reads registered projects, dispatches tasks and edits code, so the bot names the project and worktree in its message. |
| `todo` | List, show and add workspace todos, change their status (`open`, `in_progress`, `done`, `accepted`, `cancelled`) and record a result summary. |
| `message` | Send a message to another bot by id, which wakes that bot. |

Sessions a bot creates or messages are watched: when such a session finishes
its next turn, the bot is woken with the outcome. A bot therefore starts work,
ends its turn, and continues when the result is in, instead of polling.

## How a bot runs

- Each bot handles one wake at a time; several bots run concurrently.
- Automatic routing ranks the models a bot may use as a ladder. Premium-tier
  models with sufficient quota (on or behind pace) come first, then high-tier
  models with sufficient quota, then premium models ahead of pace, then the
  remaining high-tier models, and finally mid-tier models as a last resort.
  Each wake re-ranks the ladder, so a bot steps down only while the higher
  tiers have no available route and steps back up when they do.
- A bot session without an explicit model uses normal automatic routing. When
  no model is available, the wake is dropped and the error is shown on the bot.
- A failed model call keeps the existing single fallback attempt: the wake is
  retried once on the next route the ladder ranked.
- Queued wakes, watched sessions and routine rounds survive a daemon restart,
  and a wake interrupted by a restart is retried once.
- The bot's conversation is shown on the Bots page. Type in the composer there
  to wake the bot with your own message.

## Routines

A routine wakes its bot with a fixed prompt on an interval between 1 minute and
7 days. Routines come from two places:

- **Declared in the bot file** (`routines`). They are recurring, and the daemon
  keeps them in step with the file.
- **Created on the Bots page.** These can be recurring or run once after the
  interval, and can be paused, resumed, run immediately or deleted there.

A routine round lasts until the bot's work for it is done, including sessions
it started. A routine whose bot is still busy with the previous round is
skipped. With `deliver` set to `bot:<id>`, the round's final reply is sent to
that bot; `none` keeps it in the owning bot's conversation.

## Workspace todos

Todos are a small task list shared by bots, the CLI and the desktop app. Each
todo is one Markdown file in `todos/` under the workspace root, with the fields
in its front matter and the request and acceptance criteria in its body, so it
can be read and versioned like any other workspace file:

```sh
wrenyard todo add --title "Retry with backoff" --request "Use exponential backoff in billing/retry.ts" --acceptance "Unit tests cover the delay bounds" --project aurora
wrenyard todo list
wrenyard todo show <id>
wrenyard todo set-status <id> done
```

A todo can depend on others (`--depends-on <id>`) and carry attachments
(`--attach <path>`). A bot with the `todo` tool reads and updates the same
list.
