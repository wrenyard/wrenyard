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

A bot is one directory named by its id. Who the bot is can sync between your
devices; what it does on a device stays on that device.

```text
<workspace>/bots/<id>/          a bot that syncs with the workspace
  bot.json                      switches only you change: tools, enabled, primary
  identity.md                   name, icon, description and persona
  memory/                       the bot's own notes, one Markdown file each
<config root>/bots/<id>/        this device
  routines/<routine id>.md      one file per routine (see below)
```

A bot that should exist on one device only keeps `bot.json`, `identity.md`
and `memory/` in `<config root>/bots/<id>/` as well. When the same id exists in
both places, the workspace bot is used; a device directory that holds only
`routines/` is not a second bot.

The config root is `WRENYARD_CONFIG_HOME` when set, otherwise
`~/.config/wrenyard`. The daemon checks both places every few seconds, so
adding, editing or removing a file takes effect without a restart. A file that
does not validate disables only that bot (or, for a routine file, only that
routine), and the Bots page shows the error.

`bot.json`:

```json
{ "tools": { "session": true, "todo": true, "message": true } }
```

`identity.md`:

```markdown
---
name: Reviewer
icon: 🔍
description: Reviews new commits for blocking problems
---

You are the reviewer of project aurora. Keep findings short and backed by evidence.
```

## Tools

| Tool | What the bot can do |
| --- | --- |
| `session` | List, create and message work sessions, and interrupt a running turn. A work session is a full Wrenyard conversation: it reads registered projects, dispatches tasks and edits code, so the bot names the project and worktree in its message. |
| `todo` | List, show and add workspace todos, change their status (`open`, `in_progress`, `done`, `cancelled`) and record a result summary. |
| `message` | Send a message to another bot by id, which wakes that bot. |
| `memory` | Keep the bot's own memory and edit its identity. |
| `routine` | List, create, change and delete the bot's own routines on this device. |

Sessions a bot creates or messages are watched: when such a session finishes
its next turn, the bot is woken with the outcome. A bot therefore starts work,
ends its turn, and continues when the result is in, instead of polling.

## How a bot runs

- Each bot handles one wake at a time; several bots run concurrently.
- Automatic routing ranks the models a bot may use as a four-step ladder:
  premium- and high-tier models with abundant quota come first, then premium-
  and high-tier models with sufficient quota, then premium- and high-tier
  models that are nearly used up (insufficient), and finally mid-tier models in
  any usable state. Models whose quota is exhausted, or that are backing off
  after errors, are never used. Each step is ranked by score. A bot keeps the
  model of its last request for an hour after that request, so its prompt cache
  stays warm, as long as the ladder still offers that model; otherwise a wake
  takes the top of the ladder.
- The session tool takes no model or reasoning-effort parameter. A session a
  bot opens gets both its model and its reasoning effort from the same ladder,
  and later sends keep the session's current model. When no model is available,
  the wake is dropped and the error is shown on the bot. A tool call with an
  argument the tool does not declare fails with that argument named.
- A failed model call keeps the existing single fallback attempt: the wake is
  retried once on the next route the ladder ranked.
- A bot's memory works like workspace memory: before each step the memory
  search picks the entries the turn needs from the bot's own memory index, and
  a final reply may save new entries there.
- Queued wakes and watched sessions survive a daemon restart,
  and a wake interrupted by a restart is retried once.
- The bot's conversation is shown on the Bots page. Type in the composer there
  to wake the bot with your own message.

## Routines

A routine wakes its bot with a short text on an interval between 1 minute and
7 days. Each routine is one file on the device it runs on:

```markdown
---
name: morning-review
intervalMinutes: 1440
state: active
---
Morning review: follow your review-procedure memory.
```

The file name is the routine id (8 lowercase hex characters). Routines created
or paused on the Bots page write these files, and a bot with the `routine` tool
can list, create, change and delete its own routines. A routine fires into the
bot's own conversation each time, so keep its text to a trigger and keep the
procedure in a memory the routine names.

A routine whose bot is still busy with the previous run is skipped. When a bot
has no `routines/` directory yet, the routines it already had are written out
as files on the first start.

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
