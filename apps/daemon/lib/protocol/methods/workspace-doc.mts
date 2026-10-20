/**
 * Typed JSON-RPC params/results and JSON schemas for workspace.doc methods.
 *
 * Ordinary documents are addressed by project, kind and name. The fixed
 * project instruction document uses project and id: 'AGENTS.md'.
 */

import type { JsonSchema } from '../jsonrpc.mts'

export type {
  WorkspaceDocKind,
  WorkspaceDocListParams,
  WorkspaceDocEntry,
  WorkspaceDocListResult,
  WorkspaceDocReadParams,
  WorkspaceDocReadResult,
  WorkspaceDocCreateParams,
  WorkspaceDocCreateResult,
  WorkspaceDocUpdateParams,
  WorkspaceDocUpdateResult,
  WorkspaceDocEdit,
  WorkspaceDocEditParams,
  WorkspaceDocDeleteParams,
  WorkspaceDocDeleteResult,
} from '@wrenyard/protocol/workspace'

/** Kind discriminator shared by every workspace.doc schema. */
const docKindProperty = {
  type: 'string',
  enum: ['spec', 'report', 'handoff'],
  description: "The document kind: 'spec', 'report' or 'handoff'.",
} as const satisfies JsonSchema

/** Property description shared by every schema that names a document. */
const DOC_NAME_DESCRIPTION = 'The full document name, as returned by workspace.doc.list or workspace.doc.create.'

// ─── workspace.doc.list ────────────────────────────────────────────

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

export const workspaceDocReadParamsSchema = {
  type: 'object',
  properties: { project: { type: 'string', minLength: 1 }, kind: docKindProperty, name: { type: 'string', minLength: 1, description: DOC_NAME_DESCRIPTION }, id: { type: 'string', const: 'AGENTS.md' } },
  oneOf: [
    { type: 'object', description: 'Read an ordinary project document.', required: ['project', 'kind', 'name'], properties: { project: { type: 'string', minLength: 1 }, kind: docKindProperty, name: { type: 'string', minLength: 1, description: DOC_NAME_DESCRIPTION } }, additionalProperties: false },
    { type: 'object', description: 'Read the existing registered project AGENTS.md.', required: ['project', 'id'], properties: { project: { type: 'string', minLength: 1 }, id: { type: 'string', const: 'AGENTS.md' } }, additionalProperties: false },
  ],
} as const satisfies JsonSchema

export const workspaceDocReadResultSchema = {
  type: 'object',
  oneOf: [
    { type: 'object', required: ['project', 'kind', 'name', 'title', 'content', 'version'], properties: { project: { type: 'string' }, kind: docKindProperty, name: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' }, version: { type: 'string', description: 'First 8 hex characters of content SHA-256.' } }, additionalProperties: false },
    { type: 'object', required: ['project', 'id', 'title', 'content', 'version'], properties: { project: { type: 'string' }, id: { type: 'string', const: 'AGENTS.md' }, title: { type: 'string' }, content: { type: 'string' }, version: { type: 'string', description: 'First 8 hex characters of content SHA-256.' } }, additionalProperties: false },
  ],
} as const satisfies JsonSchema

// ─── workspace.doc.create ──────────────────────────────────────────

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

export const workspaceDocUpdateParamsSchema = {
  type: 'object',
  properties: { project: { type: 'string', minLength: 1 }, kind: docKindProperty, name: { type: 'string', minLength: 1 }, id: { type: 'string', const: 'AGENTS.md' }, content: { type: 'string' }, base_version: { type: 'string', minLength: 1 } },
  oneOf: [
    { type: 'object', description: 'Update an ordinary document using its read version.', required: ['project', 'kind', 'name', 'content', 'base_version'], properties: { project: { type: 'string', minLength: 1 }, kind: docKindProperty, name: { type: 'string', minLength: 1 }, content: { type: 'string' }, base_version: { type: 'string', minLength: 1 } }, additionalProperties: false },
    { type: 'object', description: 'Replace the existing registered project AGENTS.md using its read version.', required: ['project', 'id', 'content', 'base_version'], properties: { project: { type: 'string', minLength: 1 }, id: { type: 'string', const: 'AGENTS.md' }, content: { type: 'string' }, base_version: { type: 'string', minLength: 1 } }, additionalProperties: false },
  ],
} as const satisfies JsonSchema

export const workspaceDocUpdateResultSchema = {
  type: 'object',
  oneOf: [
  { type: 'object', required: ['project', 'kind', 'name', 'title', 'change', 'version'], properties: {
    project: { type: 'string', description: 'The registered project the document belongs to.' },
    kind: docKindProperty,
    name: { type: 'string', description: 'The full document name that was written.' },
    title: { type: 'string', description: "The document title: its first '# ' heading, or the name when it has none." },
    change: { type: 'string', enum: ['updated'], description: 'Always "updated" for a successful update or edit.' },
    version: {
      type: 'string',
      description: 'Version token of the written content: the first 8 hex characters of its sha256. Pass it as base_version to a later update, edit or delete.',
    },
  }, additionalProperties: false },
  { type: 'object', required: ['project', 'id', 'title', 'change', 'version'], properties: { project: { type: 'string' }, id: { type: 'string', const: 'AGENTS.md' }, title: { type: 'string' }, change: { type: 'string', const: 'updated' }, version: { type: 'string' } }, additionalProperties: false },
  ],
} as const satisfies JsonSchema

// ─── workspace.doc.edit ────────────────────────────────────────────

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
  properties: { project: { type: 'string', minLength: 1 }, kind: docKindProperty, name: { type: 'string', minLength: 1 }, id: { type: 'string', const: 'AGENTS.md' }, edits: { type: 'array', minItems: 1, items: workspaceDocEditEntrySchema }, base_version: { type: 'string', minLength: 1 } },
  oneOf: [
  { type: 'object', description: 'Apply ordered literal edits to an ordinary document. Each old must occur exactly once. base_version from doc.read is optional.', required: ['project', 'kind', 'name', 'edits'], properties: {
    project: { type: 'string', minLength: 1 }, kind: docKindProperty, name: { type: 'string', minLength: 1 }, edits: {
      type: 'array',
      minItems: 1,
      description: 'Ordered edits applied in sequence to the document content.',
      items: workspaceDocEditEntrySchema,
    }, base_version: { type: 'string', minLength: 1 },
  }, additionalProperties: false },
  { type: 'object', description: 'Apply ordered literal edits to the existing registered project AGENTS.md. Each old must occur exactly once and base_version from doc.read is required.', required: ['project', 'id', 'edits', 'base_version'], properties: { project: { type: 'string', minLength: 1 }, id: { type: 'string', const: 'AGENTS.md' }, edits: { type: 'array', minItems: 1, items: { type: 'object', required: ['old', 'new'], properties: { old: { type: 'string', minLength: 1 }, new: { type: 'string' } }, additionalProperties: false } }, base_version: { type: 'string', minLength: 1 } }, additionalProperties: false },
  ],
} as const satisfies JsonSchema

// ─── workspace.doc.delete ──────────────────────────────────────────

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
