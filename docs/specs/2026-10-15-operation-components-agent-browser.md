# Operation components: agent-browser CLI and desktop driver

> Created: 2026-10-15
> Status: Implemented; real first-device install, OS permission grant and Windows runtime not yet verified
> Requests: UeMiKxrA2SmLTy6SYwBfGs (replace browser approach with agent-browser and manage operation-component installation), KWMQ4MMWHnYvQYgf7wtShz (simplify the browser/computer capability abstraction)
> Worktree: wy-agbrw

## Problem and evidence

- This is one design for both requests, with clear implementation boundaries and no competing track.
- `packages/features/browser-use` and `packages/features/computer-use` are thin wrappers: each only names an MCP server (`browser`, `computer`) and supplies fixed instruction text. They declare no command, path, version or health logic.
- Production code still consumes them: task capability -> `testFeatureConfig.select` -> `agent-supervisor.toExecFeatureIds` -> `ExecService` select/merge -> `AgentRequest.mcpServers` plus prompt injection. `exec` already supports direct `request.mcpServers` injection.
- `apps/daemon/lib/daemon/execution/exec-features.mts` parses `WRENYARD_BROWSER_USE_MCP` / `WRENYARD_COMPUTER_USE_MCP` as JSON at daemon startup. A malformed value throws and can abort daemon startup; an unset value while a task selects the feature yields `Unknown execution feature`; there is no install, path, version or health check, and task metadata advertises features statically.
- Builtin `test` prompt text in `apps/daemon/lib/standard/tasks/test.mts` hardcodes Playwright MCP and "prefer MCP over shelling out", which conflicts with the agent-browser CLI.
- The packaged daemon is launched with bundled Node (`runtime/node`) but no npm/npx. New devices must not be required to provide npm.
- No remote execution host exists in this architecture: local IPC and local child execution only.

## Decisions

- One daemon-owned operation-component service, scoped to the daemon's machine. Installation and permission state are machine-local, not workspace or git data. The UI identifies the daemon hostname and platform. No new remote installer and no remote-execution subsystem. A remote HTTP descriptor is external/unmanaged and cannot be repaired by installing on this computer.
- Settings gets an Operation components section (Chinese UI) with two cards. It shows real states - not-installed, installing, needs-authorization, ready, failed - plus version, executable location, owning machine, check timestamp, staged progress, sanitized error, and explicit retry/repair/update/disable actions. Refresh and health checks must not install, change permissions or delete user data. Install, update, repair and permission requests happen only through explicit user actions, and installing alone must not assert readiness.
- Browser component: install the pinned official native agent-browser release directly, avoiding npm and any runtime dependency (no global npm install). Use a staged, bounded download with size and hash verification against trusted pinned release metadata, a `--version` check, and promotion only after validation; retain the previous managed version for rollback. The browser runtime is a separate install phase and must use Wrenyard-owned data locations where upstream supports it - no external profiles, no implicit config inheritance, no destructive `doctor --fix`, and no `agent-browser upgrade` (it can install npm globally). If upstream cannot isolate a location, state the exact shared location and preserve existing data rather than pretending ownership. External installations are discoverable through absolute executable resolution and supported-version validation, but are never silently overwritten, upgraded or removed. Unsupported architectures must show an honest unsupported state.
- Desktop component: Cua Driver remains the desktop MCP. On macOS the signed app identity is `com.trycua.driver`, with Accessibility and Screen Recording and an explicit permissions grant and recheck. Windows requires an interactive user desktop, not Session 0, and elevation must not be assumed to make every app controllable. Source-audit installer flags and layout before choosing any managed Cua installation command; never blanket-execute scripts that rewrite unrelated PATH, skills or Claude configuration.
- Simplification: after the call-site inventory, remove the two thin packages and the generic ExecutionFeature registry/select/merge. The generic `ExecService` keeps direct `request.mcpServers` plus normal prompt and env injection - not a renamed feature registry. Keep one narrowly scoped task/exec boundary adapter for operation requirements: browser adds a validated agent-browser executable/PATH and concise CLI instructions with a unique per-run session; desktop adds a validated Cua Driver descriptor directly to `mcpServers` plus scoped desktop guidance. No automatic browser MCP replacement and no Playwright fallback on the normal managed path. Existing arbitrary task-declared MCP stays separate. Do not change unrelated `ClientCapabilities` or model visual/tool capabilities.

## Compatibility and safety

- Accept the old builtin `test` input `capability` and the task/exec `features` aliases `browser`/`browser-use`/`computer`/`computer-use` at the boundary and convert them to explicit operation requirements. Preserve custom task feature-selection semantics and history parsing through a deprecated input adapter, not the old execution registry.
- An unknown requirement returns a targeted unsupported-requirement error and never silently disappears. Historical records stay unchanged and readable.
- Deprecate `WRENYARD_BROWSER_USE_MCP` as a non-active legacy configuration with an actionable migration notice; preserve the raw user configuration for deliberate rollback and never execute both browser paths automatically. `WRENYARD_COMPUTER_USE_MCP` may be treated as an explicit external desktop descriptor, with validation and a clearly unmanaged status.
- Parsing, discovery, timeouts and unhealthy components are isolated from daemon startup and from unrelated tools. A required-but-unavailable component returns structured, actionable installation/permission guidance, never launches a pseudo-working tool, and does not terminate the conversation or other tasks. Recheck at execution start and refresh after Settings actions - no hand-edited configuration and no daemon restart.
- Safety: a unique browser session and an owned profile; do not reuse the signed-in user Chrome or another task's session. Cua connection sessions share the real desktop, so serialize desktop operations and scope app access instead of claiming OS sandbox isolation. Preserve the existing task-purpose and sensitive-operation confirmation guidance; do not reintroduce a general permission/capability system and do not claim YOLO provides a user-consent barrier. Upstream agent-browser safety features are opt-in, so define the actual integration before claiming enforced approval. Never silently grant OS permissions.

### Compatibility inventory (completed)

- `TaskFeatureConfig.available`/`select` currently propagates through execution-kernel, structured-output retries/resume, agent primitives and the agent supervisor; keep deprecated boundary parsing/selection so user-defined task semantics survive, but remove the generic `ExecService` feature registry.
- `exec.start.features` has an `additionalProperties:false` wire schema plus Desktop IPC validation, and the CLI exposes `--features`: migrate all three together while retaining the old input alias.
- No execution-feature field is persisted in `ExecSnapshot` or in the database; the old builtin `test` `capability` lives only inside the opaque `tasks.input` JSON and stays readable without rewriting history.
- Task metadata currently exposes static features but no renderer consumes them; distinguish supported requirements from current component readiness.
- No existing test files in this worktree reference the removed abstraction, and no tests will be added or changed.
- Affected surfaces: `packages/clients/base` and the `packages/clients` re-exports; `packages/features/exec`; `packages/protocol/src/exec` and its examples; `apps/daemon/lib/core/task`, `apps/daemon/lib/core/operations`, `apps/daemon/lib/types.mts`, execution-kernel, structured-output, agent-supervisor, `apps/daemon/lib/protocol/methods/exec.mts`, `apps/daemon/lib/server/handlers/core.mts`, `apps/daemon/lib/workspace/definition-registry`; the `apps/cli` exec usage/parser; `apps/desktop` main/ipc/validation; the two 3-file thin packages plus the daemon manifest and pnpm lock.

### Pinned desktop installer audit

- Version `cua-driver-rs-v0.35.4` official install sources were audited.
- Shell/POSIX: no-PATH flags `--no-modify-path` / `CUA_DRIVER_NO_MODIFY_PATH=1`, and exact version pin `CUA_DRIVER_RS_VERSION`.
- Windows: `-NoPathUpdate` and `-Release`, with the environment variable taking precedence over `-Release`; the pinned script's baked default is `0.35.2`, so an explicit version is mandatory.
- Neither pinned installer automatically registers MCP configuration or skill links (skill linking is a separate explicit action).
- macOS app destination is fixed at `/Applications/CuaDriver.app`; no private app destination is established. The installer replaces an existing app and may reset TCC grants (Accessibility and ScreenCapture for `com.trycua.driver`) when the prior signing requirement is incompatible.
- Therefore an externally existing app is discover/check only: never apply installer repair/update over it without a separate explicit adoption/replacement decision in the UI.
- A clean-device install may use the pinned audited installer with the no-PATH flag, only after explicit user consent that shows the destination; the OS permission grant remains a separate user action.
- Windows retains releases but garbage collection defaults to five versions; do not run cleanup against an external package home as if it were Wrenyard-managed.
- Pinned installer scripts: `install.sh`, `_install-rust.sh` and `install.ps1` under https://github.com/trycua/cua/blob/cua-driver-rs-v0.35.4/libs/cua-driver/scripts/ .

## Reviewable implementation steps

1. Commit this joint design before any source change, after the compatibility and installer audit.
2. Daemon component lifecycle/status and failure isolation.
3. CLI/desktop adapter and legacy boundary; remove the obsolete registry, packages and prompts.
4. Settings bridge/UI with live status.
5. Verify, review, rebase onto latest local main, and make the local implementation commit.

No tests are added or rewritten without a separate request; inspect existing tests for impact and report contradictions rather than deleting tests to hide failures.

## Verification and remaining evidence

- Root lint/typecheck/build; isolated daemon with fresh `WRENYARD_IPC_PATH`/`WRENYARD_CONFIG_HOME`/`WRENYARD_STATE_HOME`; no writes to real config or existing profiles.
- Matrix: fresh missing components; bad legacy JSON; missing path or version mismatch; permission denial; offline/download failure; real browser open/snapshot/click/screenshot and real desktop action only when components are already available or the coordinator explicitly installs them; post-install refresh; update rollback/restart; disable/uninstall/unavailable degradation; existing tasks, CLI, old configs and history.
- Software installs during this delivery are forbidden except the worktree `pnpm install`. Real first-device install and OS permission acceptance are therefore handed to the coordinator and are not marked passed. Windows code-path review is not Windows runtime acceptance on macOS.
- Final commits carry `Refs: things:<task-id>` and `Refs: things:<task-id>`.
- Evidence: vercel-labs/agent-browser v0.39.1 README and source (https://github.com/vercel-labs/agent-browser/tree/v0.39.1); native assets `agent-browser-darwin-arm64`, `agent-browser-darwin-x64`, `agent-browser-win32-x64.exe`; `--version` prints `agent-browser <version>`; `doctor --json` returns success/summary/checks/fixed with a read-only quick/offline mode; CLI sessions default to a shared `default` unless explicitly set. Cua official driver install and permissions references; official releases report driver 0.35.4, so validate the exact pinned implementation before coding. Claude reference reviewed from official help pages: Settings extension install/configuration and automatic availability (https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop), computer-use enablement with per-application access (https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork), and Cowork browser preference with separate browser state (https://support.claude.com/en/articles/16607400-use-the-built-in-browser-in-claude-cowork). These document flows only, not visual inspection or installer progress/error/repair UI; do not invent those details.
- Remaining evidence before implementation: the compatibility/schema/history/test inventory and the pinned desktop installer audit are complete; still unresolved are the exact permission payload, browser storage/config isolation, release digests, and sensitive-action integration.

## Resolved decisions

- Sensitive actions adopt option A. The request asks to retain the existing confirmation, but the child `AgentEvent` union only has `output`/`stderr`/`error`/`exit`, and `ask` is orchestrator-only, so no runtime approval gate exists to retain. Instructions therefore tell the agent to stop before irreversible or sensitive actions (purchases, payments, sending messages, submitting credentials, downloads/uploads of user files, deleting data, changing system settings), return a `needs-confirmation` result, and then the orchestrator asks the user and dispatches a newly authorized task. This is explicitly NOT a technical per-action gate; a real pending-action approval/resume bridge is a separate future request.
- Authorship and routing: this design was authored by the orchestrator running on `codebuddy/claude-opus-5.5`. The review task `task_be217f83` resolved to `zhipu-coding/glm-5.3:oc`, timed out without output, and is not counted as a review. Persistent routing settings are unchanged.
- Baseline: the worktree was rebased onto local main `e42cfeef` (release 1.0.65); the lockfile is unchanged; baseline lint passed at `e5c065b1`.

## Implementation plan

- Daemon module `apps/daemon/lib/daemon/services/operation-components.mts` owns `browser` (agent-browser pinned 0.39.1) and `desktop` (Cua Driver pinned 0.35.4).
- Managed browser binary path: `<WRENYARD_STATE_HOME>/components/agent-browser/<version>/agent-browser[.exe]`, with a `current.json` pointer and the previous version retained for rollback.
- Discovery order: managed binary, PATH via the existing `findExecutable`, then known Cua paths (macOS `/Applications/CuaDriver.app` and `~/.local/bin/cua-driver`; Windows `%LOCALAPPDATA%\Programs\Cua\cua-driver\bin\cua-driver.exe`). Run a bounded `--version` for each discovered binary.
- Readiness: browser is a managed or PATH binary whose `--version` parses AND `agent-browser doctor --offline --quick --json` returns `success: true`; otherwise the state is failed, reporting the failing check messages plus a repair action. Exact upstream check ids are undocumented, so Wrenyard relies only on `success` and `checks[].status`/`checks[].message`. macOS desktop requires `cua-driver permissions status --json` accessibility and screen_recording true, otherwise needs-authorization; Windows desktop requires `cua-driver doctor --json` exit 0.
- States: not-installed, installing (phase and byte progress), needs-authorization, ready, failed (sanitized reason), unsupported (platform/architecture), disabled; report source managed/external, version, path, host, platform and checkedAt.
- The component snapshot carries `hints`: machine codes that Desktop renders in Chinese, instead of free-text notes - `legacy-browser-mcp`, `shared-browser-runtime`, `external-mcp`, `existing-installation`, `missing-accessibility`, `missing-screen-recording`.
- User-triggered actions only: refresh, install, update, repair, authorize (macOS: launch CuaDriver via LaunchServices then `cua-driver permissions grant`), uninstall (managed browser binary only), enable, disable.
- Browser install: staged pinned GitHub release asset download, size and SHA-256 verification against values pinned in code, version check, atomic promotion, then `agent-browser install` for Chrome for Testing in the upstream shared location `~/.agent-browser/browsers`; document this shared location and never delete it.
- Pinned agent-browser 0.39.1 assets and SHA-256 (from https://github.com/vercel-labs/agent-browser/releases/expanded_assets/v0.39.1): `agent-browser-darwin-arm64` `cc18fac41d9dc9821918340a136e643286ea05544c4dd35671b796f1a874cdef`; `agent-browser-darwin-x64` `339cb9aa6dfd404856cf938df34cd3b4779c61dfd57fc257be11b14fd1a885f9`; `agent-browser-win32-x64.exe` `af1ff5f2afd5c187fb50ac3bbc1e7114baadc180d67cef63f644af9031be5049`. Exact byte sizes are not published, so a 64 MiB download cap is used instead.
- Config isolation: upstream has no switch that disables user-config loading, but `AGENT_BROWSER_CONFIG` replaces the defaults `~/.agent-browser/config.json` and `./agent-browser.json`; Wrenyard points it at its own empty `<state>/components/agent-browser/config.json`.
- Desktop install only if no external Cua is present: download the pinned release installer asset, verify SHA-256, run with `--no-modify-path` and `CUA_DRIVER_RS_VERSION=0.35.4` on macOS or `-NoPathUpdate -Release 0.35.4` on Windows; never overwrite an existing app; the OS permission grant is a separate action.
- Pinned Cua installers from release `cua-driver-rs-v0.35.4`: `install.sh` `a103177e0df86d04d752bfa20c73f99a3e501906f1814c3127da84788539d9ba`; `install.ps1` `89ece4ed4dff3630129448a14bb06dec30adae7a2ffb3cc53b9971e7a195b097`. Limitation: run outside its source tree, `install.sh` fetches its helper from https://cua.ai/driver/_install-rust.sh (vendor-hosted), so Wrenyard enforces only the installer-script hash and the version pin.
- IPC methods are `components.list` (returns snapshots) and `components.action {id, action}` (starts an action and returns a snapshot); Desktop polls list during actions and uses a dedicated IPC client with a 90 s timeout because the first list runs both health checks.
- Add `apps/daemon/lib/daemon/execution/operation-adapter.mts`, shared by the task supervisor and the `exec.start` handler: map legacy `browser`/`browser-use` to browser and `computer`/`computer-use` to desktop; unknown IDs retain `exec_feature_unknown`; recheck readiness at execution start.
- Browser adds the managed binary directory to PATH, sets `AGENT_BROWSER_SESSION=wy-<run id>`, appends CLI instructions, and after the run best-effort runs `agent-browser --session <name> close`.
- Desktop adds the validated Cua descriptor directly to `request.mcpServers` (or an explicit external `WRENYARD_COMPUTER_USE_MCP`) plus scoped desktop instructions; desktop exclusivity is a per-owner lock (owner = task run id, else execution id), so structured-output retries of the same task are not refused while a different owner fails fast with an in-use message.
- If a component is unavailable, fail that run before spawn with actionable English guidance naming the host and Settings › 操作组件; daemon startup and unrelated tools remain unaffected.
- Remove `packages/features/browser-use`, `packages/features/computer-use`, `apps/daemon/lib/daemon/execution/exec-features.mts`, the `ExecutionFeature` type, and the ExecService feature registry/select/merge; retain direct `request.mcpServers`, env and prompt.
- For compatibility keep the task `features` config and builtin test `capability` values, the `exec.start` `features` wire field, CLI `--features`, and Desktop exec validation. Ignore `WRENYARD_BROWSER_USE_MCP` with a one-time warning and a Settings notice.
- Add the Desktop 操作组件 category/custom control with two cards showing status, version, path, host/platform, progress, error and action buttons, bridged preload → main ipcMain → daemon IPC.
- Sensitive actions (option A) are carried by the operation instructions and by the builtin test prompts: the agent must not perform irreversible or sensitive actions and instead marks the criterion `blocked` with reason `needs user confirmation: <action>`.
- Do not edit any other file, source, tests, config, or commit.

## Verification (2026-10-15)

- `pnpm run lint` (oxlint plus root and Desktop TypeScript) and `pnpm run build` pass; the lockfile no longer contains the two removed packages.
- An isolated source daemon (fresh `WRENYARD_IPC_PATH` / `WRENYARD_CONFIG_HOME` / `WRENYARD_STATE_HOME`) verified: `components.list` on this Mac reports agent-browser 0.39.1 (external, Homebrew) ready and Cua Driver 0.33.0 (existing external installation, checked only) ready.
- Uninstall of an external browser is rejected; disable/enable round-trips.
- `exec.start` with features `['browser']` or `['computer']` fails before spawn with the actionable 'not ready on host … Settings > 操作组件' message while the daemon stays healthy; `['bogus']` still maps to `exec_feature_unknown`.
- Malformed `WRENYARD_COMPUTER_USE_MCP` shows desktop failed without blocking startup; `WRENYARD_BROWSER_USE_MCP` logs the deprecation notice and adds the `legacy-browser-mcp` hint; a valid external `WRENYARD_COMPUTER_USE_MCP` is reported ready/external with only refresh and disable.
- The builtin test task description names agent-browser and Cua Driver; `~/.agent-browser` and the real config/state were untouched.
- Not verified: install/update/repair/authorize actions (downloads and installers were deliberately not run), real browser and desktop operations through a task, macOS permission denial, offline download failure, Windows behaviour, and the Settings UI visually.
- Automated code-review tasks timed out and produced no findings.
