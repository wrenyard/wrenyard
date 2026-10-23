/**
 * Typed JSON-RPC params/results for workspace.doc methods.
 *
 * Ordinary documents are addressed by project, kind and name. The fixed
 * project instruction document uses project and id: 'AGENTS.md'.
 */

/** The document kinds shared by every workspace.doc schema. */
export type WorkspaceDocKind = 'spec' | 'report' | 'handoff'

// ─── workspace.doc.list ────────────────────────────────────────────

export interface WorkspaceDocListParams {
  project: string
  kind?: WorkspaceDocKind
}

export interface WorkspaceDocEntry {
  project: string
  kind: WorkspaceDocKind
  name: string
  title: string
  status?: string
  updated?: string
}

export interface WorkspaceDocListResult {
  documents: WorkspaceDocEntry[]
}

// ─── workspace.doc.read ────────────────────────────────────────────

export type WorkspaceDocReadParams = {
  project: string
} & ({ kind: WorkspaceDocKind; name: string; id?: never } | { id: 'AGENTS.md'; kind?: never; name?: never })

export type WorkspaceDocReadResult = WorkspaceDocReadParams & { title: string; content: string; version: string }

// ─── workspace.doc.create ──────────────────────────────────────────

export interface WorkspaceDocCreateParams {
  project: string
  kind: WorkspaceDocKind
  name: string
  content: string
}

export interface WorkspaceDocCreateResult {
  project: string
  kind: WorkspaceDocKind
  name: string
  title: string
  change: 'created'
  version: string
}

// ─── workspace.doc.update ──────────────────────────────────────────

export type WorkspaceDocUpdateParams = WorkspaceDocReadParams & { content: string; base_version: string }

export type WorkspaceDocUpdateResult = WorkspaceDocReadParams & { title: string; change: 'updated'; version: string }

// ─── workspace.doc.edit ────────────────────────────────────────────

export interface WorkspaceDocEdit {
  old: string
  new: string
}

export type WorkspaceDocEditParams = {
  project: string
  edits: WorkspaceDocEdit[]
  base_version: string
} & ({ kind: WorkspaceDocKind; name: string; id?: never } | { id: 'AGENTS.md'; kind?: never; name?: never; base_version: string })

// ─── workspace.doc.delete ──────────────────────────────────────────

export interface WorkspaceDocDeleteParams {
  project: string
  kind: WorkspaceDocKind
  name: string
  /** Version token from workspace.doc.read; the optimistic concurrency token. */
  base_version: string
}

export interface WorkspaceDocDeleteResult {
  project: string
  kind: WorkspaceDocKind
  name: string
  change: 'deleted'
  version: string
}
