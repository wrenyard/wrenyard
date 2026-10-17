# Getting started

This guide takes a fresh install to a first conversation that works on one of
your repositories. It assumes the desktop app is installed (see
[Install](../../README.md#install)).

## 1. Choose a workspace

A workspace is a directory that holds your agent instructions, memories,
documents and the list of projects Wrenyard may work on. Your source code stays
in its own checkouts; the workspace only points at them.

Open **Settings › 会话 (Session)** and choose the workspace:

- **选择已有 workspace** uses an existing directory as it is.
- **新建 workspace** creates a new or empty directory with a starter layout:

  ```text
  workspace/
  ├── AGENTS.md              instructions every session reads first
  ├── instructions/          task and document conventions
  └── workspace.wrws         workspace marker
  ```

Add `memories/INDEX.md` when you want sessions to recall durable notes; each
session reads the index and searches the memories it lists. Switching the
workspace takes effect without restarting the app.

## 2. Connect a provider

Open **Settings › 供应商 (Providers)**. Activate the providers you use and
configure their credentials:

- **API-key providers** (Anthropic, OpenAI, DeepSeek, Kimi, Zhipu, OpenRouter
  and others) take a key in the 配置 dialog. Keys are stored in your local
  config directory with owner-only permissions.
- **Subscription providers** reuse the login of their official client: ChatGPT
  through Codex, Claude through Claude Code, and Cursor, CodeBuddy and Grok
  through their own CLIs. Sign in with that client once; Wrenyard reads and
  refreshes the login through it.

Each active provider shows its status, its models and, where the provider
reports it, quota windows with their reset times. The full list is in
[Supported providers](../model-providers.md).

## 3. Register a project

A project is a repository Wrenyard may read and change. Register it in the
workspace with one file:

```text
projects/<name>/<name>.fmproj
```

```yaml
name: aurora
display_name: "Aurora"
description: "Billing service"
git:
  remote: https://github.com/example/aurora.git
  default_branch: main
hosts:
  my-laptop: "/path/to/aurora"
```

`hosts` maps a machine's host name to the checkout path on that machine, so one
workspace can serve several computers. You can also ask a session to register
a project for you. Check the result with:

```sh
wrenyard project list
wrenyard project describe aurora
```

A project may add its own `AGENTS.md` and its own task definitions next to the
`.fmproj` file.

## 4. Start a conversation

Press <kbd>⌘N</kbd> (<kbd>Ctrl+N</kbd> on Windows) and describe what you want,
naming the project. Pick the main reasoning model and its reasoning effort in
the composer; the other roles are routed automatically to cheap, fast models.

While the session works:

- replies stream into the conversation, and task cards show each dispatched
  `explore`, `edit` or `test` run with its status;
- the status bar shows the context occupancy of the next request, generation
  speed, cache hits, tokens and the tightest quota window;
- the detailed view (top-right toggle) shows every step, call and task.

For larger changes, ask the session to work in a managed worktree: it creates
one per change, and your main checkout stays untouched until you ask it to
merge.

## 5. Keep work going

- [Bots and routines](bots.md) automate recurring work: a bot can review todos
  every morning, open sessions for them, and report the results.
- **Mini mode** (title bar) keeps a conversation in a small card on top of
  other windows.
- **Settings › 操作组件 (Operation components)** installs the browser and
  desktop drivers that tasks use for real UI checks.
- **Settings › 运行环境 (Runtime) › Gateway 接入** shows the local gateway
  address and token for editors that speak the OpenAI or Anthropic API.

## Running without the desktop app

On a machine without a display, run the daemon in a terminal and use the CLI:

```sh
wrenyard daemon run
wrenyard session create
wrenyard session send <sessionId> "Summarise the open todos" --model <provider/model> --reasoning-effort high
wrenyard session events <sessionId> --follow
```

The desktop app can also connect to such a machine over SSH from the
connection menu at the bottom of the sidebar (远程连接).
