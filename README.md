<div align="center">

<img src="packages/themes/src/paper/assets/icon-256.png" width="96" alt="" />

# Wrenyard

**A local-first desktop workbench for orchestrating AI engineering work.**

One conversation reasons about the goal; exploration, edits, tests and commits
run as parallel tasks on the models you already pay for — with every token,
quota window and task visible.

[![Release](https://img.shields.io/github/v/release/wrenyard/wrenyard?label=latest)](https://github.com/wrenyard/wrenyard/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Platforms](https://img.shields.io/badge/platforms-macOS%20arm64%20%7C%20Windows%20x64-lightgrey)

[中文](README.zh-CN.md) · [Download](https://github.com/wrenyard/wrenyard/releases) · [Documentation](docs/README.md)

</div>

![Wrenyard Desktop](docs/images/hero.png)

> **Development preview.** Wrenyard ships rolling `1.0.x` patch releases. It is
> used daily by its authors, but it is not production-ready yet — see
> [Status](#status).

## Why Wrenyard

- **Reasoning stays expensive, everything else stays cheap.** The main model
  only reasons and declares what should happen. Cheap models compile its
  intents, search documents, recall memories and write the replies, and agent
  tasks do the hands-on work on whichever model fits.
- **Context you can audit.** A session is one append-only ledger, and every
  reasoning request is the previous one with a segment appended, so prompt
  caches keep hitting. The status bar shows how full the next request is for
  the model you picked, and the detailed view shows every request, task and
  action that produced a reply.
- **Your providers, your quota.** Claude, ChatGPT, Cursor, Kimi, Zhipu,
  DeepSeek, CodeBuddy, OpenRouter and 30 more providers sit side by side with
  remaining quota, pace and reset times. Task routing weighs price, speed,
  quota and capability automatically, and free models form their own pool.
- **Work that keeps going without you.** Bots are agents with their own
  instructions and tools: woken by routines, by messages or by the sessions
  they started, they open sessions, track todos and report back.
- **Local-first.** A local daemon owns tasks and state over owner-only IPC.
  Nothing is hosted for you, and nothing leaves your machine except the model
  requests you make.

## A tour

### Conversations that dispatch work

The session page is the main workspace. Each reply can fan out into `explore`,
`edit`, `test` and `commit` tasks across your registered projects, search
workspace documents, update specs and commit changes — all declared by the
main model as typed actions. Drop, pick or paste files into the composer;
messages and task results show their files with previews, and Markdown replies
render code and Mermaid diagrams. When a turn ends on a question, the session
is marked as waiting for you, and the composer suggests a likely next message
you can accept with <kbd>Tab</kbd>.

Switch to the **detailed view** to see how a reply was made: every reasoning
step, the auxiliary calls around it, each action and agent task with its model,
duration, tokens and status, and the raw output behind each one.

![Detailed view of a session](docs/images/transcript.png)

### See the next request before you send it

The ring in the status bar shows how full the main model's next request will be
against its usable window. Open it for a breakdown of the conversation context
and of every auxiliary role (reply, dispatch, document, search, memory, title)
with the model serving it. Next to it, the session metrics show generation
speed, the cache hit rate and total tokens.

![Context meter](docs/images/context-meter.png)

### Bots and routines

The **Bots** page runs agents you define in a small JSON file: a name,
instructions, and the tools each one may use — open and steer work sessions,
manage the built-in workspace todos, or message another bot. A routine wakes a
bot on an interval, and its result can be delivered to another bot. Sessions a
bot starts are watched, so it is woken again when they finish. See the
[bots guide](docs/guides/bots.md).

![Bots](docs/images/agents.png)

### Quota, pace and resets at a glance

Settings › Providers lists every provider with its status, models and quota
windows: remaining quota per window, a pace marker that shows whether you are
burning faster than an even rate, and the time until reset. The status bar
always shows the tightest window. Models that support a verified fast tier
offer a **Fast** option in the model picker.

![Providers](docs/images/providers.png)

### A ledger of the work

The Workshop Ledger summarises dispatches, token use, completion rate and task
time, with a year-long activity heatmap and per-model and per-task breakdowns.

![Workshop ledger](docs/images/ledger.png)

### Everywhere you work

- **Mini mode** opens a conversation as a small frameless card that can stay on
  top of other windows, and follows the main window's theme.
- **Pet** is an optional desktop companion that shows running tasks, task
  graphs and quota at the edge of your screen.
- **Remote** connects the app to a Wrenyard daemon on another machine over SSH.
- **Operation components** let tasks drive a browser (`agent-browser`) and the
  desktop (Cua Driver); the app installs, authorizes and health-checks them.
- **Gateway access** exposes the local model gateway on `127.0.0.1` with a
  fixed or random port and a persistent token, so editors such as Zed can use
  your providers.

### Make it yours

Two built-in themes — the warm **Paper** and the shadcn-style **Neutral** — each
in light and dark, following the system or set by hand. Settings are searchable
and grouped into pages.

| Paper Light | Paper Dark |
| --- | --- |
| ![Paper Light](docs/images/themes.png) | ![Paper Dark](docs/images/session-paper-dark.png) |
| ![Neutral Light](docs/images/session-neutral.png) | ![Neutral Dark](docs/images/session-neutral-dark.png) |

## Install

Download the installer for your platform from the
[releases page](https://github.com/wrenyard/wrenyard/releases):

| Platform | File |
| --- | --- |
| macOS (Apple Silicon) | `wrenyard-desktop-<version>-darwin-arm64.dmg` |
| Windows (x64) | `wrenyard-desktop-<version>-win32-x64-setup.exe` |

The app bundles everything it needs: the `wrenyard` CLI, a Node runtime and the
daemon.

**First launch.** Preview builds are ad-hoc signed on macOS and unsigned on
Windows, so the OS asks once:

- **macOS** — open *System Settings → Privacy & Security* and choose
  *Open Anyway*.
- **Windows** — on the SmartScreen prompt choose *More info → Run anyway*.

Then follow [Getting started](docs/guides/getting-started.md) to pick a
workspace, connect a provider and register your first project.

**Updates.** The app checks the update feed, verifies the download's SHA-256
and installs it when you choose. Quit the app fully from the menu bar or tray
for an update to apply.

## Command line

The same `wrenyard` command ships inside the app (on Windows the installer can
add it to `PATH`). Every business command accepts `--json`.

```text
wrenyard desktop                  launch the desktop app
wrenyard daemon run|stop|status   run or inspect the local control plane
wrenyard session …                create, message and follow conversations
wrenyard task list|describe|run   delegate and track project work
wrenyard project …                registered projects, worktrees, diff and commit
wrenyard workspace …              workspace status, documents and version control
wrenyard todo …                   the built-in workspace todos
wrenyard quota [provider]         provider quota
wrenyard exec <prompt> --target   one-off agent execution
wrenyard taskgraph …              task graphs for multi-step work
wrenyard storage [preview|run]    data-directory usage and guarded cleanup
wrenyard doctor                   check the local install
```

The CLI never starts a daemon on its own: open the app, or run
`wrenyard daemon run` in a terminal.

Seven built-in task roles share one runtime and automatic model selection:

| Task | Use it to |
| --- | --- |
| `explore` | answer a factual question about code, history or logs |
| `edit` | apply bounded file changes |
| `test` | run verification and report evidence |
| `code-review` | review correctness against requirements |
| `commit` | create verified local commits |
| `librarian` | research external documentation |
| `oracle` | think through hard trade-offs |

Projects can add their own tasks next to these, or extend a built-in one with
extra instructions and requirements.

## Build from source

Requirements: Node.js ≥ 24.19 and pnpm 11.19 (via `corepack enable`).

```sh
git clone https://github.com/wrenyard/wrenyard.git
cd wrenyard
pnpm install --frozen-lockfile
pnpm dev        # daemon + desktop with hot reload
```

`pnpm dev` refuses to start next to a running daemon, so quit the installed app
first. See the [development guide](docs/development.md) for the dev loop, shared
data directories, screenshots and release packaging, and read
[CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Repository layout

```text
apps/desktop     the desktop app (Electron + React, shadcn/ui, Tailwind), Pet included
apps/daemon      the local control plane: tasks, sessions, bots, routines, gateway
apps/cli         the wrenyard command
packages/        features (session, providers, quota, routing, exec, …),
                 protocol, client adapters, execution primitives and themes
tools/           checks, demos and release tooling
docs/            user guides, architecture, development and release notes
```

Read more in [docs/architecture.md](docs/architecture.md).

## Status

Wrenyard publishes rolling `1.0.x` patch releases for macOS (Apple Silicon) and
Windows (x64). Each release is a normal GitHub release, and the update feed
head is `latest.json` on the `updates` branch, with a continuing `dev.json`
compatibility alias. Before it is production-ready it still needs trusted code
signing ([signing notes](docs/release/signing.md)), wider clean-machine testing
and a documented compatibility policy. Nothing is published to npm.

## Documentation

Start at the [documentation index](docs/README.md):

- [Getting started](docs/guides/getting-started.md)
- [Bots and routines](docs/guides/bots.md)
- [Supported providers](docs/model-providers.md)
- [Architecture](docs/architecture.md) · [Development guide](docs/development.md)
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE). Third-party notices are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and are verified by
`pnpm check`.
