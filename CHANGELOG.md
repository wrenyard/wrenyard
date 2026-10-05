# Changelog

## 1.0.0-dev.46

Attachments in the conversation, a session context that only ever appends, and
ChatGPT subscription models as main-reasoning supply.

### Session

- Every main reasoning request is the previous one with a segment appended, so
  provider prompt caches keep hitting; requests of one session are queued to
  keep the history linear.
- The main model declares actions through a native `wy_action` tool call
  instead of text markers. Task results reach it as Markdown text, and
  document writes go through the `doc` task.
- Attach files to a message: images are resized and re-encoded once, text is
  capped per file, and files stay in the conversation by path. Deleting a
  session removes its files and run artifacts.
- Main reasoning runs over the Chat Completions or the Responses protocol,
  chosen from what the model's provider declares.

### Desktop

- Composer: drop, pick or paste files; they show as a removable attachment
  strip with thumbnails and are saved with the draft. Messages and task
  results show their files with previews.
- Inspector: one expandable tree of turns, cycles, calls and actions replaces
  the timeline and detail panes, with the main model's raw output and
  reasoning, the context segments of each request and cache usage.
- Model picker: entries read `provider · model`, list only models that can run
  main reasoning, explain the runtime on hover, and mark free, quota-abundant
  and fast models. Session defaults use the same picker.
- Queued task runs are shown as queued, with their real start time.

### Tasks

- New `doc` builtin that writes or edits one workspace document.
- Run artifacts: every run gets its own artifact directory, and a task whose
  output schema declares artifacts can return files from it.
- A project task file can `extends` the definition of the same id (the nearest
  ancestor project, then the builtin) to add instructions, dispatch
  requirements or a time limit without replacing it. `task describe` and the
  Desktop task detail show the inheritance chain.
- A run that is about to exceed its time limit is resumed once to stop and
  summarize; the output is marked as truncated. Time spent waiting in the queue
  no longer counts against the limit.
- `explore` answers one factual question and returns an answer with locations.

### Providers

- ChatGPT subscription models are served through the gateway over the Responses
  protocol, using the existing Codex ChatGPT login.
- CodeBuddy offers the Claude 5.5 generation in place of Claude 5, and GPT 6
  Sol in place of GPT 5.6.

## 1.0.0-dev.45

### Desktop

- Keep the session sidebar width stable when opening or closing the inspector.
- Use rounded macOS Dock and Finder icons with transparent margins for both themes.
- Focus status-bar quota on the selected session model, with shared 5h/7d usage cards, pacing and reset times.
- Respect Claude Code quota refresh intervals and Retry-After cooldowns; retain stale quota data during rate limits.
- Restore dragging across blank title-bar areas while keeping controls clickable.
- Wait for daemon startup before loading the shell so initial session reads do not fail during cold startup.

### Pet

- Preserve transparent companion windows when appearance or system color mode changes.
- Consolidate Pet windows, preload bridges and lifecycle ownership under the Pet module.
- Render bubbles, labels, quota tips and transcripts with shared React UI; keep pixel art and animations in PixiJS.
- Replace the custom Graph Slip layout with React Flow and dagre, and replay initial window updates across renderer startup.

## 1.0.0-dev.44

A redesigned Desktop built on shadcn/ui and Tailwind, with a ledger-backed
conversation page and much deeper observability.

### Desktop

- New window frame: a custom title bar with sidebar toggle, back/forward
  history and page actions (the Windows menu folds into a title bar button),
  and a full-width status bar showing the daemon, running tasks and task graphs,
  the tightest quota window, updates and a notification history.
- Conversation page rebuilt around the session ledger: per-session drafts, a
  context ring that predicts the next reasoning request for the selected model,
  a usage panel with quota, pace and reset times, and an inspector context tab
  with composition, growth, a cross-model preview and per-role call costs.
  Sending is blocked when the context no longer fits the selected model.
- Model Supply restores quota pace markers and reset countdowns in a compact
  one-line-per-provider list.
- Settings redesigned after editor settings pages: searchable, with a
  category outline, modified markers and reset, plus new general, appearance,
  session and notification settings and a read-only shortcut list.
- Themes moved into the `@wrenyard/themes` package. Paper and Neutral each
  come in light and dark (or follow the system), and the app icon follows the
  theme. A consistent motion system respects reduced-motion settings.
- Unified toasts, notification history with do-not-disturb, system
  notifications while the window is in the background, and a single
  confirmation dialog pattern.
- `pnpm dev` builds show a 开发模式 badge.

### Fixes

- Long pages (for example the task run history) scroll instead of clipping.
- Dragging a scrollbar next to a panel divider no longer resizes the panels.
- Tokens above one billion render as `B` instead of thousands of `M`.

### Documentation

- Rewritten README with screenshots and a product tour video, a development
  guide, and documentation cleaned of retired components.

## 1.0.0-dev.34 – 1.0.0-dev.43

Development preview release.

### Daemon service surface

- Make the daemon local-first and IPC-only. Its only external interface is
  owner-only NDJSON JSON-RPC (a unix socket on macOS, a named pipe on Windows);
  there is no MCP, REST or message HTTP surface and no listener for external
  clients. `health.ping` now reports an integer `protocolVersion`, and the
  client refuses a version mismatch instead of negotiating compatibility.
- Give the daemon one run entry point, `wrenyard daemon run`, which runs in the
  foreground: the first SIGINT/SIGTERM drains active work and a second forces
  shutdown. Desktop, `pnpm --filter @wrenyard/daemon dev`,
  `pnpm --filter @wrenyard/desktop dev` and the terminal all use it. Remove
  `wrenyard daemon start` (detached mode, the
  `wrenyard-daemon.json` state file and `--host`/`--port`) and
  `wrenyard daemon restart`; keep `daemon stop` and `daemon status`.
- Make Desktop the daemon owner: it connects to a daemon that is already
  running or supervises one with the packaged runtime, is tray-resident on
  every platform (closing the window hides it; only the tray “退出” command
  quits), and shows “daemon stopped” with a restart action after a clean stop.
  The CLI never starts or restarts the daemon and reports a single message when
  none is running.
- Confine the gateway to the daemon process tree: bind `127.0.0.1:0` (a random
  loopback port), mint a fresh in-memory token on every start, and serve only
  `/gateway/*`. Remove the fixed `service.bind`/`host`/`port` configuration,
  the `EADDRINUSE` retry, the on-disk `gateway/credential` and the credential
  helper.

### Removed surface

- Remove MCP (`/mcp`, `ForemanMcpServer`, `protocol/agent-tools.mts`), REST
  (`server/http/*` and `/api/v1/*`) and the message subsystem (the telegram,
  wecom, webhook, openclaw, cc-channel, remote and system backends;
  `/message/deliver`, `/channel/*` and `/mcp/channel/events`; the `message.send`
  RPC; and `wrenyard message`).
- Remove external client configuration (ccswitch): the daemon
  `client-configuration/` tree and the `client.configuration.*` RPCs, the
  control-client methods, and Desktop's Clients page and IPC. Independently
  injected stdio MCP servers (`browser-use`, `computer-use` and task-declared
  `mcpServers`) are unaffected.

### Distribution

- Ship Desktop installers only. Each release publishes three artifacts
  (Windows `setup.exe`, macOS `.dmg` and macOS in-app-update `.zip`); the suite
  zip, the SEA install engine (`wrenyard install`/`wrenyard update`), the
  one-click bootstrap scripts and `pnpm release:local`/`install:local`/
  `version:sync` are gone. Desktop updates itself from the channel feed on the
  `updates` branch and does not roll back a failed update in the first version.
- Converge root scripts to `build`, `dev`, `release`, `lint`, `check`, `test`
  and `wrenyard`.

### Migration from external client configuration

- Upgrading drops external client configuration without automatic restoration.
  Before upgrading, open the old Desktop Clients page and click Restore for
  each client; if you already upgraded, manually remove the base URL and
  credential-helper entries Wrenyard wrote from your Claude Code, Codex, Grok
  Build or Claude App configuration so they no longer point at
  `127.0.0.1:8787/gateway/...`.

### Release simplification

- Reduce the version source to the root `package.json`, synced only to the
  Desktop package; the suite version is read from `SUITE_VERSION`.
- Delete the planned-restart subsystem and the source-checkout updater.
  Task-context daemon stop is refused.
- Remove the Go/Forge leftovers: the root `go.work`, the Go toolchain
  requirement, and the stale asset-provenance entry.

## 1.0.0-dev.33

Development preview release.

- Align model names and icons, use themed speed and free-model badges, and show
  quota details in a scrollable themed tooltip.
- Compact the session list, preview truncated titles, show the workspace folder
  name, and simplify conversation chrome with a rounded composer and send button.
- Preserve task definition display names from dispatch through completion and
  keep task labels arranged horizontally with wrapping.
- Remove page reload shortcuts from the application menu.
- Retain a sanitized last-update-attempt record across restarts and update checks,
  including the failed phase, native error, exit code and recovery outcome.

## 1.0.0-dev.32

Development preview release.

- Run conversation turns independently, cancel each turn separately, and retain
  conversation history, work details and completed usage across restarts.
- Generate a separate final summary using a configurable model, with DeepSeek
  V4.1 Flash as the default and an available provider selected automatically.
- Simplify the work header and composer, show a rolling preview of the latest
  step, and keep tool details inside the expandable work history.
- Remove GPT 5.4 Mini from the model catalog and ChatGPT provider.

## 1.0.0-dev.21

Development preview release.

### Application updates

- Add Help → Check for Updates with native current/update/download/restart
  dialogs and a one-hour GitHub Releases cache shared by automatic and manual
  checks.
- Add recoverable atomic Desktop replacement on Apple Silicon macOS and
  Windows x64. The external helper updates Desktop and the suite together,
  rolls back Desktop when the suite update fails, and relaunches the app.
- Verify release archives with GitHub's recorded SHA-256 asset digest so future
  releases no longer need public checksum sidecars.

### Distribution

- Maintain public releases for `darwin-arm64` and `win32-x64` only.
- Publish only the suite and Desktop archives required by users; manifests,
  component packages, installers, notices and aggregate checksums remain CI
  evidence.
- Make the one-command installer bootstrap the full suite and Desktop product.

## 1.0.0-dev.16

Development preview release.

### Desktop productization

- Add a model picker to conversations with availability-aware ordering and a
  shared user-controlled order across model and Provider surfaces.
- Replace the quota page with the localized Provider directory, including Key
  configuration, friendly login/configuration states, aligned quota rows, and
  a single public CodeBuddy identity.
- Use the 「工坊工作区」 product name, show the suite version in the title bar,
  add rotating workshop prompt copy, and reduce daemon readiness to a status
  lamp with uptime details.

### Updates

- Add non-blocking stable/development update channels to Desktop settings.
- Verify Desktop and suite assets with checksums before staging; macOS applies
  them through an external transactional helper with rollback and active-work
  guards.

### Providers and models

- Add public API Provider modules for OpenAI, Anthropic, Zhipu, Moonshot,
  MiniMax, Qwen, Tencent Cloud TokenHub, and Volcengine while keeping native
  subscription credentials distinct.
- Update DeepSeek and CodeBuddy model catalogs, adopt the SpaceXAI Provider
  name, and require the selected client binary before a profile is offered.
- Record only unambiguous, non-rate-limit CodeBuddy monthly exhaustion locally;
  mixed monthly and transient errors never persist until the next month.

## 1.0.0-dev.0

Development preview release.

### Unified identity

- One product in one monorepo: the `wrenyard` command surface is the single
  public entry point for the CLI, the control plane, the precompiled Go
  runtime, and the desktop observer.
- Legacy compatibility entry points are no longer part of the public command
  surface.

### Release and updater

- Latest-dev installer installs the platform-qualified suite
  (`wrenyard-<version>-<target>-suite.zip`) from the public `wrenyard/wrenyard`
  repository, selecting the host target automatically.
- `wrenyard update` supports updating the local install to the latest-dev
  build, with uninstall and rollback guidance.

### Precompiled runtime

- The Forge Go runtime is shipped as precompiled per-platform packages for
  `darwin-arm64`, `darwin-x64`, `linux-x64`, and `win32-x64`.
- The packed CLI and the portable suite zip bundle the pinned Node runtime
  that built them, keeping native ABI behavior stable.

### Desktop

- The Desktop DSH shell observer surface is introduced as a preview, hosting
  the task/taskgraph visualizer.

### Pet

- The Pet observer surface preview reads task and taskgraph progress from the
  control plane over a read-only protocol.

### Signing (honest)

- Preview builds are signed ad-hoc on macOS, checksum-only on Linux, and
  unsigned by default on Windows; trusted release signing is future work and
  never runs in this repository.
