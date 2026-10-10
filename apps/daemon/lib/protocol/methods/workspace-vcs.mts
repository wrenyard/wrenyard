import type { JsonSchema } from '../jsonrpc.mts'

const nullableStringSchema = {
  anyOf: [
    { type: 'string' },
    { type: 'null' },
  ],
} as const satisfies JsonSchema

// ─── workspace.vcs.status ──────────────────────────────────────────────

export interface WorkspaceVcsStatusEntry {
  path: string
  index: string
  worktree: string
  origPath?: string
}

export interface WorkspaceVcsStatusParams {}

export interface WorkspaceVcsStatusResult {
  branch: string | null
  head: string | null
  upstream: string | null
  ahead: number
  behind: number
  entries: WorkspaceVcsStatusEntry[]
}

export const workspaceVcsStatusParamsSchema = {
  type: 'object',
  additionalProperties: false,
} as const satisfies JsonSchema

export const workspaceVcsStatusEntrySchema = {
  type: 'object',
  required: ['path', 'index', 'worktree'],
  properties: {
    path: { type: 'string', minLength: 1, description: 'Workspace-relative path of the changed file.' },
    index: { type: 'string', minLength: 1, description: 'Index (staged) status character from git status --porcelain.' },
    worktree: { type: 'string', minLength: 1, description: 'Working-tree status character from git status --porcelain.' },
    origPath: { type: 'string', minLength: 1, description: 'Original path of a rename or copy, when the record is one.' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const workspaceVcsStatusResultSchema = {
  type: 'object',
  required: ['branch', 'head', 'upstream', 'ahead', 'behind', 'entries'],
  properties: {
    branch: { ...nullableStringSchema, description: 'Current branch of the workspace repository, or null on a detached HEAD.' },
    head: { ...nullableStringSchema, description: 'Current commit hash, or null on an unborn branch.' },
    upstream: { ...nullableStringSchema, description: 'Upstream branch the current branch tracks, or null when none is set.' },
    ahead: { type: 'integer', minimum: 0, description: 'Number of commits the current branch is ahead of its upstream.' },
    behind: { type: 'integer', minimum: 0, description: 'Number of commits the current branch is behind its upstream.' },
    entries: {
      type: 'array',
      items: workspaceVcsStatusEntrySchema,
      description: 'Working-tree status entries of the workspace repository.',
    },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

// ─── workspace.vcs.diff ────────────────────────────────────────────────

export interface WorkspaceVcsDiffParams {
  paths?: string[]
  staged?: boolean
}

export interface WorkspaceVcsDiffResult {
  diff: string
}

export const workspaceVcsDiffParamsSchema = {
  type: 'object',
  properties: {
    paths: {
      type: 'array',
      items: { type: 'string', minLength: 1, description: 'Workspace-relative path to limit the diff to.' },
      description: 'Optional workspace-relative paths to limit the diff to.',
    },
    staged: { type: 'boolean', description: 'Diff the staged index (git diff --cached) rather than the working tree.' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const workspaceVcsDiffResultSchema = {
  type: 'object',
  required: ['diff'],
  properties: {
    diff: { type: 'string', description: 'Unified diff text; empty when there are no changes.' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

// ─── workspace.vcs.commit ──────────────────────────────────────────────

export interface WorkspaceVcsCommitParams {
  message: string
  files: string[]
}

export interface WorkspaceVcsCommitResult {
  hash: string
  branch: string | null
  files: string[]
  shortstat: string
}

export const workspaceVcsCommitParamsSchema = {
  type: 'object',
  required: ['message', 'files'],
  properties: {
    message: { type: 'string', minLength: 1, description: 'Commit message; must not be empty.' },
    files: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1, description: 'Workspace-relative file path to commit.' },
      description: 'Exactly the workspace-relative files to stage and commit; no other path is staged. Refuses with file_unchanged, foreign_staged or staged_mismatch when the staged set does not match.',
    },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const workspaceVcsCommitResultSchema = {
  type: 'object',
  required: ['hash', 'branch', 'files', 'shortstat'],
  properties: {
    hash: { type: 'string', minLength: 1, description: 'Commit hash of the created commit.' },
    branch: { ...nullableStringSchema, description: 'Branch the commit landed on, or null on a detached HEAD.' },
    files: {
      type: 'array',
      items: { type: 'string', minLength: 1, description: 'Committed workspace-relative file path.' },
      description: 'The exact files committed.',
    },
    shortstat: { type: 'string', description: 'git show --shortstat summary line for the commit.' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

// ─── workspace.vcs.push ────────────────────────────────────────────────

export interface WorkspaceVcsPushParams {}

export interface WorkspaceVcsPushResult {
  branch: string
  remote: string
  pushed: boolean
  head?: string
  summary: string
  reason?: string
  error?: string
}

export const workspaceVcsPushParamsSchema = {
  type: 'object',
  additionalProperties: false,
} as const satisfies JsonSchema

export const workspaceVcsPushResultSchema = {
  type: 'object',
  required: ['branch', 'remote', 'pushed', 'summary'],
  properties: {
    branch: { type: 'string', description: 'Current branch the push targeted; empty when it could not be resolved.' },
    remote: { type: 'string', description: 'Remote pushed to; always origin.' },
    pushed: { type: 'boolean', description: 'True when the push to origin succeeded. Pushes only to origin on the current branch; never force and never tags, and the workspace repository may hold uncommitted files.' },
    head: { type: 'string', description: 'Commit hash pushed, when the push succeeded.' },
    summary: { type: 'string', description: 'One-line human-readable outcome.' },
    reason: { type: 'string', description: 'Machine-readable failure reason when pushed is false.' },
    error: { type: 'string', description: 'Human-readable failure message when pushed is false.' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

// ─── workspace.vcs.pull ────────────────────────────────────────────────

export interface WorkspaceVcsPullParams {}

export interface WorkspaceVcsPullResult {
  branch: string
  remote: string
  pulled: boolean
  summary: string
  reason?: string
  error?: string
}

export const workspaceVcsPullParamsSchema = {
  type: 'object',
  additionalProperties: false,
} as const satisfies JsonSchema

export const workspaceVcsPullResultSchema = {
  type: 'object',
  required: ['branch', 'remote', 'pulled', 'summary'],
  properties: {
    branch: { type: 'string', description: 'Current branch the pull targeted; empty when it could not be resolved.' },
    remote: { type: 'string', description: 'Remote pulled from; always origin.' },
    pulled: { type: 'boolean', description: 'True when the pull succeeded. Pulls origin with fast-forward only and requires a clean tree.' },
    summary: { type: 'string', description: 'One-line human-readable outcome.' },
    reason: { type: 'string', description: 'Machine-readable failure reason when pulled is false.' },
    error: { type: 'string', description: 'Human-readable failure message when pulled is false.' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema
