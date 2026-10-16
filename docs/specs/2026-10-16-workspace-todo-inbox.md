# Workspace Todo Inbox

## Decision
The Bot’s task source is the built-in workspace todo system. Things remains an optional command adapter; leave existing configurations and data untouched. Do not migrate or delete Things data, change live mode, or switch production configuration.

## Todo files and API
Store one Markdown file at `todos/<id>.md`, with a short, stable, immutable ID. YAML front matter contains `id`, `title`, `status` (`open | in_progress | done | accepted | cancelled`), optional `project`, optional `depends_on` IDs, and `created`/`updated` timestamps. The body contains `Request` and `Acceptance criteria` sections; attachments, if any, use relative paths only. The Markdown files are authoritative. A disposable SQLite index mirrors the parsed fields (`id`, `title`, `status`, `project`, `depends_on`, `created`, `updated`); it is rebuilt from the Markdown files on every read and after every write, lives under the daemon's local state directory outside the workspace Git tree (never the runtime database), and is harmless to delete because it is fully reproduced from the files.

Provide daemon IPC operations `todo.list`, `todo.get`, `todo.create`, and `todo.update`, and CLI commands `wrenyard todo list|add|show|set-status`. Validate IDs, statuses, dependencies, timestamps, unknown fields, and safe relative attachment paths with actionable errors. Writes are atomic. Do not provide deletion; use `cancelled` instead.

## Bot and Desktop
New bots default to `inbox.kind='workspace'`; retain the existing command adapter behavior for Things and do not alter existing bot configs. The workspace inbox stays behind the existing `list/get/complete/annotate/release` interface. `complete` writes `done` (execution finished); acceptance separately writes `accepted`; neither state implies the other. Respect dependencies when offering work for intake. Preserve dry-run side-effect guards and keep inbox integration small; autonomous Bot-loop redesign belongs to another session.

Desktop provides the smallest useful read/write 待办 list and detail with title, status, project, and dependencies, plus add and status change. No boards, assignees, or comments.

## Confirmed seed
Create the confirmed todo `管理 Agent 客户端的安装与升级`: “List supported agent clients' install state, version, update availability, and source; support install and upgrade with progress, errors, retry, and re-detect; avoid duplicate installs; distinguish local vs remote executor; protect running tasks; keep separate from operation components; use Magpie as the design reference, with Opus-led design.” Do not invent additional confirmed seed items.

## Deferred and verification
Git sync automation, multi-device claiming/handoff, conflicts, and tombstones are follow-ups only, not implementation scope. Verify necessary focused tests, `pnpm lint`, `pnpm test`, and real isolated-daemon IPC/CLI plus Desktop screenshots for list/detail/add/status change. Do not change production configuration or deploy; report honestly what dry-run does and does not verify.

## Open questions / 待确认
No blocking questions for the minimum implementation. Production rollout or live-mode switching, and any additional seed items, require user input. Creating seed todos in the actual workspace requires an authorized tool path; never silently substitute a repository fixture.
