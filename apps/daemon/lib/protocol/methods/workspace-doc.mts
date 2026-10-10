/**
 * Typed JSON-RPC params/results and JSON schemas for workspace.doc methods.
 *
 * Documents are addressed by project, kind and name only: every params and
 * result carries exactly those fields. No generic operations are exposed.
 */

import type { JsonSchema } from '../jsonrpc.mts'

/** The document kinds shared by every workspace.doc schema. */
export type WorkspaceDocKind = 'spec' | 'report' | 'handoff'

/** Kind discriminator shared by every workspace.doc schema. */
const docKindProperty = {
  type: 'string',
  enum: ['spec', 'report', 'handoff'],
  description: "The document kind: 'spec', 'report' or 'handoff'.",
} as const satisfies JsonSchema

/** Property description shared by every schema that names a document. */
const DOC_NAME_DESCRIPTION = 'The full document name, as returned by workspace.doc.list or workspace.doc.create.'

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

export const workspaceDocListParamsSchema = {
  type: 'object',
  description: 'List the documents of one registered project, optionally limited to one kind. Refuses an unregistered project with unknown_project.',
  required: ['project'],
  properties: {
    project: {
      type: 'string',
      minLength: 1,
      description: 'The registered project whose documents are listed.',
    },
    kind: docKindProperty,
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const workspaceDocListResultSchema = {
  type: 'object',
  description: 'The documents of the requested project, sorted by kind then name.',
  required: ['documents'],
  properties: {
    documents: {
      type: 'array',
      description: 'The matching documents.',
      items: {
        type: 'object',
        required: ['project', 'kind', 'name', 'title'],
        properties: {
          project: { type: 'string', description: 'The registered project the document belongs to.' },
          kind: docKindProperty,
          name: { type: 'string', description: 'The document name.' },
          title: { type: 'string', description: "The document title: its first '# ' heading, or the name when it has none." },
          status: { type: 'string', description: 'The status header field read from the document, when present.' },
          updated: { type: 'string', description: 'The updated header field read from the document, when present.' },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

// ─── workspace.doc.read ────────────────────────────────────────────

export interface WorkspaceDocReadParams {
  project: string
  kind: WorkspaceDocKind
  name: string
}

export interface WorkspaceDocReadResult {
  project: string
  kind: WorkspaceDocKind
  name: string
  title: string
  content: string
  version: string
}

export const workspaceDocReadParamsSchema = {
  type: 'object',
  description: 'Read one document of one registered project and its current version token. Refuses a document that does not exist with missing.',
  required: ['project', 'kind', 'name'],
  properties: {
    project: { type: 'string', minLength: 1, description: 'The registered project the document belongs to.' },
    kind: docKindProperty,
    name: { type: 'string', minLength: 1, description: DOC_NAME_DESCRIPTION },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const workspaceDocReadResultSchema = {
  type: 'object',
  required: ['project', 'kind', 'name', 'title', 'content', 'version'],
  properties: {
    project: { type: 'string', description: 'The registered project the document belongs to.' },
    kind: docKindProperty,
    name: { type: 'string', description: 'The full document name that was read.' },
    title: { type: 'string', description: "The document title: its first '# ' heading, or the name when it has none." },
    content: { type: 'string', description: 'Full UTF-8 content of the document.' },
    version: {
      type: 'string',
      description: 'Version token of the content: the first 8 hex characters of its sha256. Pass it as base_version to workspace.doc.update, workspace.doc.edit or workspace.doc.delete.',
    },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

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

export const workspaceDocCreateParamsSchema = {
  type: 'object',
  description:
    "Create one document in a registered project. name is a short lowercase slug and the date prefix is added automatically. Refuses with exists when the document already exists, bad_name when name is not a short lowercase slug, unknown_project when the project is not registered and bad_kind when the kind is not spec, report or handoff.",
  required: ['project', 'kind', 'name', 'content'],
  properties: {
    project: { type: 'string', minLength: 1, description: 'The registered project the document belongs to.' },
    kind: docKindProperty,
    name: {
      type: 'string',
      minLength: 1,
      description: 'A short lowercase slug for the new document; the date prefix is added automatically and the returned name is the full document name.',
    },
    content: { type: 'string', description: 'Full UTF-8 Markdown content to write.' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const workspaceDocCreateResultSchema = {
  type: 'object',
  required: ['project', 'kind', 'name', 'title', 'change', 'version'],
  properties: {
    project: { type: 'string', description: 'The registered project the document belongs to.' },
    kind: docKindProperty,
    name: { type: 'string', description: 'The full document name, including the date prefix.' },
    title: { type: 'string', description: "The document title: its first '# ' heading, or the name when it has none." },
    change: { type: 'string', enum: ['created'], description: 'Always "created" for a successful create.' },
    version: {
      type: 'string',
      description: 'Version token of the written content: the first 8 hex characters of its sha256. Pass it as base_version to a later update, edit or delete.',
    },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

// ─── workspace.doc.update ──────────────────────────────────────────

export interface WorkspaceDocUpdateParams {
  project: string
  kind: WorkspaceDocKind
  name: string
  content: string
  /** Version token from workspace.doc.read; the optimistic concurrency token. */
  base_version: string
}

export interface WorkspaceDocUpdateResult {
  project: string
  kind: WorkspaceDocKind
  name: string
  title: string
  change: 'updated'
  version: string
}

export const workspaceDocUpdateParamsSchema = {
  type: 'object',
  description:
    "Overwrite one existing document in a registered project. name is a full name returned by workspace.doc.list or workspace.doc.create and base_version comes from workspace.doc.read. Refuses with missing when the document does not exist and conflict when base_version does not match the current content.",
  required: ['project', 'kind', 'name', 'content', 'base_version'],
  properties: {
    project: { type: 'string', minLength: 1, description: 'The registered project the document belongs to.' },
    kind: docKindProperty,
    name: { type: 'string', minLength: 1, description: DOC_NAME_DESCRIPTION },
    content: { type: 'string', description: 'Full UTF-8 Markdown content to write.' },
    base_version: {
      type: 'string',
      minLength: 1,
      description: "Version token from workspace.doc.read. Refuses with conflict when it no longer matches the current content.",
    },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const workspaceDocUpdateResultSchema = {
  type: 'object',
  required: ['project', 'kind', 'name', 'title', 'change', 'version'],
  properties: {
    project: { type: 'string', description: 'The registered project the document belongs to.' },
    kind: docKindProperty,
    name: { type: 'string', description: 'The full document name that was written.' },
    title: { type: 'string', description: "The document title: its first '# ' heading, or the name when it has none." },
    change: { type: 'string', enum: ['updated'], description: 'Always "updated" for a successful update or edit.' },
    version: {
      type: 'string',
      description: 'Version token of the written content: the first 8 hex characters of its sha256. Pass it as base_version to a later update, edit or delete.',
    },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

// ─── workspace.doc.edit ────────────────────────────────────────────

export interface WorkspaceDocEdit {
  old: string
  new: string
}

export interface WorkspaceDocEditParams {
  project: string
  kind: WorkspaceDocKind
  name: string
  edits: WorkspaceDocEdit[]
  base_version?: string
}

const workspaceDocEditEntrySchema = {
  type: 'object',
  required: ['old', 'new'],
  properties: {
    old: { type: 'string', description: "Exact text to replace; it must occur exactly once in the document or the edit is refused with not_found or not_unique." },
    new: { type: 'string', description: 'Replacement text, inserted verbatim with no $ replacement patterns interpreted.' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const workspaceDocEditParamsSchema = {
  type: 'object',
  description:
    "Apply ordered literal edits to one existing document in a registered project. name is a full name returned by workspace.doc.list or workspace.doc.create. Each old must occur exactly once; otherwise the edit is refused with not_found or not_unique naming the offending edit by index. When base_version, taken from workspace.doc.read, is given and does not match the current content, refuses with conflict.",
  required: ['project', 'kind', 'name', 'edits'],
  properties: {
    project: { type: 'string', minLength: 1, description: 'The registered project the document belongs to.' },
    kind: docKindProperty,
    name: { type: 'string', minLength: 1, description: DOC_NAME_DESCRIPTION },
    edits: {
      type: 'array',
      minItems: 1,
      description: 'Ordered edits applied in sequence to the document content.',
      items: workspaceDocEditEntrySchema,
    },
    base_version: {
      type: 'string',
      minLength: 1,
      description: "Optional version token from workspace.doc.read. Refuses with conflict when it no longer matches the current content.",
    },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

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

export const workspaceDocDeleteParamsSchema = {
  type: 'object',
  description:
    "Delete exactly one document of a registered project. name is a full name returned by workspace.doc.list or workspace.doc.create and base_version comes from workspace.doc.read, so a document changed since it was read is not deleted. Refuses with missing when the document does not exist, not_a_file when it is not a regular document, and conflict when base_version no longer matches the current content.",
  required: ['project', 'kind', 'name', 'base_version'],
  properties: {
    project: { type: 'string', minLength: 1, description: 'The registered project the document belongs to.' },
    kind: docKindProperty,
    name: { type: 'string', minLength: 1, description: DOC_NAME_DESCRIPTION },
    base_version: {
      type: 'string',
      minLength: 1,
      description: "Version token from workspace.doc.read. Refuses with conflict when it no longer matches the current content.",
    },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const workspaceDocDeleteResultSchema = {
  type: 'object',
  required: ['project', 'kind', 'name', 'change', 'version'],
  properties: {
    project: { type: 'string', description: 'The registered project the document belonged to.' },
    kind: docKindProperty,
    name: { type: 'string', description: 'The full document name that was deleted.' },
    change: { type: 'string', enum: ['deleted'], description: 'Always "deleted" for a successful delete.' },
    version: { type: 'string', description: 'Version token of the deleted content, equal to the base_version that was passed.' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema
