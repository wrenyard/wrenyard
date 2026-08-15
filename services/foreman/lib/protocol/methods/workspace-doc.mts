/**
 * Typed JSON-RPC params/results and JSON schemas for workspace.doc methods.
 *
 * Paths are workspace-relative Markdown paths. No generic file operations
 * or delete are exposed.
 */

import type { JsonSchema } from '../jsonrpc.mts'

// ─── workspace.doc.list ────────────────────────────────────────────

export interface WorkspaceDocListParams {
  directory?: string
}

export interface WorkspaceDocEntry {
  path: string
}

export interface WorkspaceDocListResult {
  files: WorkspaceDocEntry[]
}

export const workspaceDocListParamsSchema = {
  type: 'object',
  properties: {
    directory: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const workspaceDocListResultSchema = {
  type: 'object',
  required: ['files'],
  properties: {
    files: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

// ─── workspace.doc.read ────────────────────────────────────────────

export interface WorkspaceDocReadParams {
  path: string
}

export interface WorkspaceDocReadResult {
  path: string
  content: string
}

export const workspaceDocReadParamsSchema = {
  type: 'object',
  required: ['path'],
  properties: {
    path: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const workspaceDocReadResultSchema = {
  type: 'object',
  required: ['path', 'content'],
  properties: {
    path: { type: 'string' },
    content: { type: 'string' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

// ─── workspace.doc.create ──────────────────────────────────────────

export interface WorkspaceDocCreateParams {
  path: string
  content: string
}

export interface WorkspaceDocCreateResult {
  path: string
}

export const workspaceDocCreateParamsSchema = {
  type: 'object',
  required: ['path', 'content'],
  properties: {
    path: { type: 'string', minLength: 1 },
    content: { type: 'string' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const workspaceDocCreateResultSchema = {
  type: 'object',
  required: ['path'],
  properties: {
    path: { type: 'string' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

// ─── workspace.doc.update ──────────────────────────────────────────

export interface WorkspaceDocUpdateParams {
  path: string
  content: string
}

export interface WorkspaceDocUpdateResult {
  path: string
}

export const workspaceDocUpdateParamsSchema = {
  type: 'object',
  required: ['path', 'content'],
  properties: {
    path: { type: 'string', minLength: 1 },
    content: { type: 'string' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const workspaceDocUpdateResultSchema = {
  type: 'object',
  required: ['path'],
  properties: {
    path: { type: 'string' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema
