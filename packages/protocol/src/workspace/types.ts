/**
 * Typed params/results for the daemon-owned workspace and remote host
 * methods: workspace.switch, workspace.inspect, workspace.initialize and
 * remote.host.list/save/rename. Relocated verbatim from the daemon protocol
 * registry so the wire types live next to the rest of the IDL.
 */

// ── workspace.switch ──────────────────────────────────────────────────
// The daemon-owned idle-only workspace hot switch. Declared inline next to the
// workspace.doc.* / workspace.vcs.* entries because it is the one protocol
// method whose authority lives entirely in the daemon's own lifecycle.

export interface WorkspaceSwitchParams {
  /** Path of the workspace root to bind. Resolved and validated by the daemon. */
  root: string
}

/** Closed outcome of one workspace.switch call. */
export type WorkspaceSwitchOutcome =
  /** The daemon rebound every workspace-scoped service to the new root. */
  | 'switched'
  /** Refused: the daemon still has admitted work or an in-flight workspace operation. */
  | 'busy'
  /** Refused: the requested root is not an existing, resolvable directory. */
  | 'invalid'
  /** Refused: a shutdown was already requested. */
  | 'shutting_down'
  /** Refused: WRENYARD_WORKSPACE or --work-dir pins the root outside the config. */
  | 'pinned'
  /** Refused: this daemon exposes no switch implementation. */
  | 'unavailable'
  /** Failed unexpectedly; the previous root and config were kept. */
  | 'error'

export interface WorkspaceSwitchResult {
  ok: boolean
  outcome: WorkspaceSwitchOutcome
  /** Canonical workspace root now in effect; present only on a successful switch. */
  workspace_root?: string
  /** Human-readable reason for a non-success outcome. Never a credential or path leak beyond the requested root. */
  message?: string
}

// ── remote.host.* / workspace.inspect / workspace.initialize ──────────
// Remote-connection management is owned by the daemon config, exactly like
// workspace.switch is owned by the daemon lifecycle. These methods are declared
// inline: the daemon is the authority for the saved-host registry, and the
// remote-safe workspace operations let Desktop inspect/initialize the active
// workspace without ever stat'ing or creating a remote path locally. None of
// these ever carry a password, private key or other secret.

/** One saved remote host, as presented over IPC. `displayName` is always resolved. */
export interface RemoteHostRecord {
  /** Concrete SSH `Host` alias; never a wildcard or negated pattern. */
  alias: string
  /** Resolved user-facing display name (falls back to the alias). */
  displayName: string
  /** Verified remote operating system, present only after a ready connection. */
  platform?: string
  /** Verified remote CPU architecture, present only after a ready connection. */
  arch?: string
  /** Verified remote daemon product version at save time. */
  daemonVersion?: string
}

/** The saved remote host list. */
export interface RemoteHostListResult {
  hosts: RemoteHostRecord[]
}

export type RemoteHostListParams = Record<string, never>

/**
 * Remember a host only after a validated, compatible, ready remote connection.
 * `ready: true` is the caller's attestation that validation and remote readiness
 * succeeded; a host is never saved from a probe or a failed confirmation.
 */
export interface RemoteHostSaveParams {
  alias: string
  displayName?: string
  platform: string
  arch: string
  daemonVersion: string
  ready: true
}

export interface RemoteHostRenameParams {
  alias: string
  displayName: string
}

export type RemoteHostMutationResult = RemoteHostListResult

/** Remote-safe inspection of the active daemon's workspace root. */
export interface WorkspaceInspectParams {
  /** Optional candidate root; when omitted the daemon inspects its own root. */
  root?: string
}

export type WorkspaceInspectOutcome = 'configured' | 'missing' | 'invalid'

export interface WorkspaceInspectResult {
  ok: boolean
  outcome: WorkspaceInspectOutcome
  /** Canonical root inspected (the daemon's own root when none was requested). */
  root: string
  /** Whether the root exists as a directory on the daemon's host. */
  exists: boolean
  /** True when the root is pinned by the daemon environment and not editable. */
  readOnly: boolean
  message?: string
}

/** Remote-safe initialization of a new workspace directory on the daemon host. */
export interface WorkspaceInitializeParams {
  root: string
}

export type WorkspaceInitializeOutcome = 'initialized' | 'exists' | 'busy' | 'invalid' | 'unavailable' | 'error'

export interface WorkspaceInitializeResult {
  ok: boolean
  outcome: WorkspaceInitializeOutcome
  root?: string
  message?: string
}
