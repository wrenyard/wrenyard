import type { JsonSchema } from '../jsonrpc.mts'

const nullableStringSchema = {
  anyOf: [
    { type: 'string' },
    { type: 'null' },
  ],
} as const satisfies JsonSchema

const recordSchema = {
  type: 'object',
  additionalProperties: true,
} as const satisfies JsonSchema

export interface ProjectListParams {}

export interface ProjectEntry {
  name: string
  path: string
  noWorktree?: boolean
  gitRemote?: string
  defaultBranch?: string
  implicit?: boolean
}

export type ProjectListResult = ProjectEntry[]

export interface ProjectDescribeParams {
  project: string
}

export type ProjectDescribeResult = ProjectEntry

export interface WorktreeInfo {
  id: string
  path: string
  branch: string | null
  clean: boolean
}

export interface ProjectOverview {
  name: string
  path: string
  worktree_count: number
}

export interface ProjectDetail {
  name: string
  path: string
  worktrees: WorktreeInfo[]
}

export interface ProjectStatusParams {
  project?: string
}

export type ProjectStatusResult = ProjectDetail | ProjectOverview[]

export interface ProjectPullParams {
  project: string
}

export interface ProjectPullResult {
  project: string
  path?: string
  branch?: string
  remote?: string
  pulled: boolean
  reason?: string
  error?: string
  dirty?: Record<string, unknown>
  summary: string
}

export interface ProjectPushParams {
  project?: string
  worktree_id?: string
}

export interface ProjectPushResult {
  project?: string
  worktree_id?: string
  path?: string
  branch?: string
  remote?: string
  pushed: boolean
  reason?: string
  error?: string
  dirty?: Record<string, unknown>
  summary: string
}

export interface ProjectWorktreeListParams {
  project: string
}

export type ProjectWorktreeListResult = WorktreeInfo[]

export interface ProjectWorktreeCreateParams {
  project: string
  worktree_id?: string
  branch?: string
}

export interface ProjectWorktreeCreateResult {
  project: string
  worktree_id: string
  path: string
  branch: string
}

export interface ProjectWorktreeMergeParams {
  project: string
  worktree_id: string
}

export interface ProjectWorktreeMergeResult {
  project: string
  worktree_id: string
  branch?: string
  target_branch?: string
  worktree_path?: string
  before_sha?: string
  after_sha?: string
  worktree_sha?: string
  commit_count?: number
  merged: boolean
  removed: boolean
  branch_deleted?: boolean
  reason?: string
  error?: string
}

export interface ProjectWorktreeRemoveParams {
  worktree_id: string
  project?: string
}

export interface ProjectWorktreeRemoveResult {
  worktree_id: string
  removed: boolean
  project?: string
  path?: string
  error?: string
}

const requiredProjectParamsSchema = {
  type: 'object',
  required: ['project'],
  properties: {
    project: { type: 'string', minLength: 1 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const projectListParamsSchema = {
  type: 'object',
  additionalProperties: true,
} as const satisfies JsonSchema

export const projectEntrySchema = {
  type: 'object',
  required: ['name', 'path'],
  properties: {
    name: { type: 'string', minLength: 1 },
    path: { type: 'string', minLength: 1 },
    noWorktree: { type: 'boolean' },
    gitRemote: { type: 'string' },
    defaultBranch: { type: 'string' },
    implicit: { type: 'boolean' },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const projectListResultSchema = {
  type: 'array',
  items: projectEntrySchema,
} as const satisfies JsonSchema

export const projectDescribeParamsSchema = requiredProjectParamsSchema
export const projectDescribeResultSchema = projectEntrySchema
export const projectStatusParamsSchema = {
  type: 'object',
  properties: {
    project: { type: 'string', minLength: 1 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const worktreeInfoSchema = {
  type: 'object',
  required: ['id', 'path', 'branch', 'clean'],
  properties: {
    id: { type: 'string', minLength: 1 },
    path: { type: 'string', minLength: 1 },
    branch: nullableStringSchema,
    clean: { type: 'boolean' },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const projectDetailSchema = {
  type: 'object',
  required: ['name', 'path', 'worktrees'],
  properties: {
    name: { type: 'string', minLength: 1 },
    path: { type: 'string', minLength: 1 },
    worktrees: {
      type: 'array',
      items: worktreeInfoSchema,
    },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const projectOverviewSchema = {
  type: 'object',
  required: ['name', 'path', 'worktree_count'],
  properties: {
    name: { type: 'string', minLength: 1 },
    path: { type: 'string', minLength: 1 },
    worktree_count: { type: 'integer', minimum: 0 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const projectStatusResultSchema = {
  anyOf: [
    projectDetailSchema,
    {
      type: 'array',
      items: projectOverviewSchema,
    },
  ],
} as const satisfies JsonSchema

export const projectPullParamsSchema = requiredProjectParamsSchema

export const projectPullResultSchema = {
  type: 'object',
  required: ['project', 'pulled', 'summary'],
  properties: {
    project: { type: 'string', minLength: 1 },
    path: { type: 'string' },
    branch: { type: 'string' },
    remote: { type: 'string' },
    pulled: { type: 'boolean' },
    reason: { type: 'string' },
    error: { type: 'string' },
    dirty: recordSchema,
    summary: { type: 'string' },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const projectPushParamsSchema = {
  type: 'object',
  anyOf: [
    { required: ['project'] },
    { required: ['worktree_id'] },
  ],
  properties: {
    project: { type: 'string', minLength: 1 },
    worktree_id: { type: 'string', minLength: 1 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const projectPushResultSchema = {
  type: 'object',
  required: ['pushed', 'summary'],
  properties: {
    project: { type: 'string' },
    worktree_id: { type: 'string' },
    path: { type: 'string' },
    branch: { type: 'string' },
    remote: { type: 'string' },
    pushed: { type: 'boolean' },
    reason: { type: 'string' },
    error: { type: 'string' },
    dirty: recordSchema,
    summary: { type: 'string' },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const projectWorktreeListParamsSchema = requiredProjectParamsSchema

export const projectWorktreeListResultSchema = {
  type: 'array',
  items: worktreeInfoSchema,
} as const satisfies JsonSchema

export const projectWorktreeCreateParamsSchema = {
  type: 'object',
  required: ['project'],
  properties: {
    project: { type: 'string', minLength: 1 },
    worktree_id: { type: 'string', minLength: 1 },
    branch: { type: 'string', minLength: 1 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const projectWorktreeCreateResultSchema = {
  type: 'object',
  required: ['project', 'worktree_id', 'path', 'branch'],
  properties: {
    project: { type: 'string', minLength: 1 },
    worktree_id: { type: 'string', minLength: 1 },
    path: { type: 'string', minLength: 1 },
    branch: { type: 'string', minLength: 1 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const projectWorktreeMergeParamsSchema = {
  type: 'object',
  required: ['project', 'worktree_id'],
  properties: {
    project: { type: 'string', minLength: 1 },
    worktree_id: { type: 'string', minLength: 1 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const projectWorktreeMergeResultSchema = {
  type: 'object',
  required: ['project', 'worktree_id', 'merged', 'removed'],
  properties: {
    project: { type: 'string', minLength: 1 },
    worktree_id: { type: 'string', minLength: 1 },
    branch: { type: 'string' },
    target_branch: { type: 'string' },
    worktree_path: { type: 'string' },
    before_sha: { type: 'string' },
    after_sha: { type: 'string' },
    worktree_sha: { type: 'string' },
    commit_count: { type: 'integer', minimum: 0 },
    merged: { type: 'boolean' },
    removed: { type: 'boolean' },
    branch_deleted: { type: 'boolean' },
    reason: { type: 'string' },
    error: { type: 'string' },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const projectWorktreeRemoveParamsSchema = {
  type: 'object',
  required: ['worktree_id'],
  properties: {
    worktree_id: { type: 'string', minLength: 1 },
    project: { type: 'string', minLength: 1 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const projectWorktreeRemoveResultSchema = {
  type: 'object',
  required: ['worktree_id', 'removed'],
  properties: {
    worktree_id: { type: 'string', minLength: 1 },
    removed: { type: 'boolean' },
    project: { type: 'string' },
    path: { type: 'string' },
    error: { type: 'string' },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

// ─── project.commitLog ─────────────────────────────────────────────────

export interface CommitLogEntry {
  sha: string
  authored_at: string
  author_name: string
  subject: string
}

export interface ProjectCommitLogParams {
  project: string
  limit?: number
}

export interface ProjectCommitLogResult {
  project: string
  commits: CommitLogEntry[]
}

export const commitLogEntrySchema = {
  type: 'object',
  required: ['sha', 'authored_at', 'author_name', 'subject'],
  properties: {
    sha: { type: 'string', minLength: 1 },
    authored_at: { type: 'string', minLength: 1 },
    author_name: { type: 'string', minLength: 1 },
    subject: { type: 'string' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const projectCommitLogParamsSchema = {
  type: 'object',
  required: ['project'],
  properties: {
    project: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const projectCommitLogResultSchema = {
  type: 'object',
  required: ['project', 'commits'],
  properties: {
    project: { type: 'string', minLength: 1 },
    commits: {
      type: 'array',
      items: commitLogEntrySchema,
    },
  },
  additionalProperties: false,
} as const satisfies JsonSchema
