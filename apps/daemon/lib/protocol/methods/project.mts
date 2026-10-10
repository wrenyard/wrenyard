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
  displayName?: string
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
    project: { type: 'string', minLength: 1, description: 'Registered project name.' },
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
    displayName: { type: 'string' },
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
    project: { type: 'string', minLength: 1, description: 'Project to inspect; omitted lists every project and its worktree count.' },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const worktreeInfoSchema = {
  type: 'object',
  required: ['id', 'path', 'branch', 'clean'],
  properties: {
    id: { type: 'string', minLength: 1, description: 'Managed worktree id.' },
    path: { type: 'string', minLength: 1, description: 'Absolute filesystem path of the worktree.' },
    branch: { ...nullableStringSchema, description: 'Branch the worktree is on, or null on a detached HEAD.' },
    clean: { type: 'boolean', description: 'True when the worktree has no uncommitted changes.' },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const projectDetailSchema = {
  type: 'object',
  required: ['name', 'path', 'worktrees'],
  properties: {
    name: { type: 'string', minLength: 1, description: 'Registered project name.' },
    path: { type: 'string', minLength: 1, description: 'Absolute filesystem path of the project checkout.' },
    worktrees: {
      type: 'array',
      items: worktreeInfoSchema,
      description: 'Managed worktrees of the project, sorted by id.',
    },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const projectOverviewSchema = {
  type: 'object',
  required: ['name', 'path', 'worktree_count'],
  properties: {
    name: { type: 'string', minLength: 1, description: 'Registered project name.' },
    path: { type: 'string', minLength: 1, description: 'Absolute filesystem path of the project checkout.' },
    worktree_count: { type: 'integer', minimum: 0, description: 'Number of managed worktrees the project currently has.' },
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
    project: { type: 'string', minLength: 1, description: 'Project the pull targeted.' },
    path: { type: 'string', description: 'Absolute checkout path the pull ran in.' },
    branch: { type: 'string', description: 'Current branch that was pulled.' },
    remote: { type: 'string', description: 'Remote pulled from; always origin.' },
    pulled: { type: 'boolean', description: 'True when the fast-forward pull succeeded.' },
    reason: { type: 'string', description: 'Machine-readable failure reason when pulled is false.' },
    error: { type: 'string', description: 'Human-readable failure message when pulled is false.' },
    dirty: recordSchema,
    summary: { type: 'string', description: 'One-line human-readable outcome.' },
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
    project: { type: 'string', minLength: 1, description: 'Project whose base checkout is pushed; provide this or worktree_id.' },
    worktree_id: { type: 'string', minLength: 1, description: 'Managed worktree to push; provide this or project.' },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const projectPushResultSchema = {
  type: 'object',
  required: ['pushed', 'summary'],
  properties: {
    project: { type: 'string', description: 'Project the push targeted.' },
    worktree_id: { type: 'string', description: 'Worktree the push targeted, when one was given.' },
    path: { type: 'string', description: 'Absolute checkout path the push ran in.' },
    branch: { type: 'string', description: 'Current branch that was pushed.' },
    remote: { type: 'string', description: 'Remote pushed to; always origin.' },
    pushed: { type: 'boolean', description: 'True when the clean-checkout push succeeded.' },
    reason: { type: 'string', description: 'Machine-readable failure reason when pushed is false.' },
    error: { type: 'string', description: 'Human-readable failure message when pushed is false.' },
    dirty: recordSchema,
    summary: { type: 'string', description: 'One-line human-readable outcome.' },
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
    project: { type: 'string', minLength: 1, description: 'Project to create the worktree for.' },
    worktree_id: { type: 'string', minLength: 1, description: 'Optional fixed worktree id; omitted ids are generated.' },
    branch: { type: 'string', minLength: 1, description: 'Branch to check out; omitted uses a generated wrenyard/<id> branch.' },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const projectWorktreeCreateResultSchema = {
  type: 'object',
  required: ['project', 'worktree_id', 'path', 'branch'],
  properties: {
    project: { type: 'string', minLength: 1, description: 'Project the worktree belongs to.' },
    worktree_id: { type: 'string', minLength: 1, description: 'Id of the created worktree.' },
    path: { type: 'string', minLength: 1, description: 'Absolute filesystem path of the created worktree.' },
    branch: { type: 'string', minLength: 1, description: 'Branch the created worktree is on.' },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const projectWorktreeMergeParamsSchema = {
  type: 'object',
  required: ['project', 'worktree_id'],
  properties: {
    project: { type: 'string', minLength: 1, description: 'Project that owns the worktree to merge.' },
    worktree_id: { type: 'string', minLength: 1, description: 'Managed worktree to rebase, merge, and remove.' },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const projectWorktreeMergeResultSchema = {
  type: 'object',
  required: ['project', 'worktree_id', 'merged', 'removed'],
  properties: {
    project: { type: 'string', minLength: 1, description: 'Project the merge targeted.' },
    worktree_id: { type: 'string', minLength: 1, description: 'Worktree that was merged.' },
    branch: { type: 'string', description: 'Feature branch of the worktree.' },
    target_branch: { type: 'string', description: 'Target branch the worktree was rebased onto and fast-forwarded.' },
    worktree_path: { type: 'string', description: 'Absolute path of the merged worktree.' },
    before_sha: { type: 'string', description: 'Target branch head before the fast-forward.' },
    after_sha: { type: 'string', description: 'Target branch head after the fast-forward.' },
    worktree_sha: { type: 'string', description: 'Rebased worktree head that was merged.' },
    commit_count: { type: 'integer', minimum: 0, description: 'Number of commits the worktree added over the target.' },
    merged: { type: 'boolean', description: 'True when the target branch was fast-forwarded.' },
    removed: { type: 'boolean', description: 'True when the worktree was removed after merging.' },
    branch_deleted: { type: 'boolean', description: 'True when the merged feature branch was deleted.' },
    reason: { type: 'string', description: 'Machine-readable failure or refusal reason.' },
    error: { type: 'string', description: 'Human-readable failure message.' },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const projectWorktreeRemoveParamsSchema = {
  type: 'object',
  required: ['worktree_id'],
  properties: {
    worktree_id: { type: 'string', minLength: 1, description: 'Managed worktree id to remove.' },
    project: { type: 'string', minLength: 1, description: 'Optional owning project to validate before removing.' },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const projectWorktreeRemoveResultSchema = {
  type: 'object',
  required: ['worktree_id', 'removed'],
  properties: {
    worktree_id: { type: 'string', minLength: 1, description: 'Worktree the removal targeted.' },
    removed: { type: 'boolean', description: 'True when the worktree was removed.' },
    project: { type: 'string', description: 'Owning project, when it could be resolved.' },
    path: { type: 'string', description: 'Absolute path of the removed worktree.' },
    error: { type: 'string', description: 'Human-readable failure message when removed is false.' },
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

// ─── project.diff / project.commit ─────────────────────────────────────

export interface ProjectDiffParams {
  project: string
  worktree_id?: string
  paths?: string[]
  staged?: boolean
}

export interface ProjectDiffResult {
  project: string
  worktree_id?: string
  diff: string
}

export interface ProjectCommitParams {
  project: string
  worktree_id?: string
  message: string
  files: string[]
}

export interface ProjectCommitResult {
  project: string
  worktree_id?: string
  hash: string
  branch: string | null
  files: string[]
  shortstat: string
}

export const projectDiffParamsSchema = {
  type: 'object',
  required: ['project'],
  properties: {
    project: { type: 'string', minLength: 1, description: 'Registered project name whose checkout is diffed.' },
    worktree_id: { type: 'string', minLength: 1, description: 'Managed worktree id; omitted diffs the base project checkout.' },
    paths: {
      type: 'array',
      items: { type: 'string', minLength: 1, description: 'Workspace-relative path to limit the diff to.' },
      description: 'Optional workspace-relative paths to limit the diff to.',
    },
    staged: { type: 'boolean', description: 'Diff the staged index (git diff --cached) rather than the working tree.' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const projectDiffResultSchema = {
  type: 'object',
  required: ['project', 'diff'],
  properties: {
    project: { type: 'string', minLength: 1, description: 'Project the diff was taken from.' },
    worktree_id: { type: 'string', minLength: 1, description: 'Worktree the diff was taken from, when one was targeted.' },
    diff: { type: 'string', description: 'Unified diff text; empty when there are no changes.' },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const projectCommitParamsSchema = {
  type: 'object',
  required: ['project', 'message', 'files'],
  properties: {
    project: { type: 'string', minLength: 1, description: 'Registered project name whose checkout is committed.' },
    worktree_id: { type: 'string', minLength: 1, description: 'Managed worktree id; omitted commits in the base project checkout.' },
    message: { type: 'string', minLength: 1, description: 'Commit message; must not be empty.' },
    files: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1, description: 'Workspace-relative file path to commit.' },
      description: 'Exactly the workspace-relative files to commit; no other path is staged.',
    },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const projectCommitResultSchema = {
  type: 'object',
  required: ['project', 'hash', 'branch', 'files', 'shortstat'],
  properties: {
    project: { type: 'string', minLength: 1, description: 'Project the commit landed in.' },
    worktree_id: { type: 'string', minLength: 1, description: 'Worktree the commit landed in, when one was targeted.' },
    hash: { type: 'string', minLength: 1, description: 'Commit hash of the created commit.' },
    branch: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: 'Branch the commit landed on, or null on a detached HEAD.',
    },
    files: {
      type: 'array',
      items: { type: 'string', minLength: 1, description: 'Committed workspace-relative file path.' },
      description: 'The exact files committed.',
    },
    shortstat: { type: 'string', description: 'git show --shortstat summary line for the commit.' },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

// ─── project.register ──────────────────────────────────────────────────

export interface ProjectRegisterParams {
  project: string
  description: string
  display_name?: string
  checkout_path?: string
  git_remote?: string
  default_branch?: string
}

export interface ProjectRegisterResult {
  project: string
  file: string
  path: string | null
  git_remote?: string
  default_branch?: string
  registered: boolean
}

export const projectRegisterParamsSchema = {
  type: 'object',
  required: ['project', 'description'],
  properties: {
    project: {
      type: 'string',
      minLength: 1,
      description: "Project id: the path under projects/ and may be nested such as 'gol/arts'. Each '/'-separated segment matches [A-Za-z0-9._-]. This writes projects/<id>/<last segment>.fmproj and refuses an id that already exists.",
    },
    description: {
      type: 'string',
      minLength: 1,
      description: 'Human-readable project description; required and must be non-empty.',
    },
    display_name: {
      type: 'string',
      description: 'Optional human-facing display label written to the .fmproj display_name field.',
    },
    checkout_path: {
      type: 'string',
      description: "Optional absolute path of this device's checkout; must already exist as a directory.",
    },
    git_remote: {
      type: 'string',
      description: 'Optional git remote URL; detected from the checkout origin when omitted.',
    },
    default_branch: {
      type: 'string',
      description: 'Optional default branch; detected from the checkout when omitted.',
    },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const projectRegisterResultSchema = {
  type: 'object',
  required: ['project', 'file', 'path', 'registered'],
  properties: {
    project: { type: 'string', minLength: 1, description: 'Project id that was registered.' },
    file: { type: 'string', minLength: 1, description: "Workspace-relative .fmproj path with forward slashes, e.g. 'projects/gol/arts/arts.fmproj'." },
    path: { ...nullableStringSchema, description: 'Absolute checkout path that was written, or null when none was given.' },
    git_remote: { type: 'string', description: 'Git remote URL recorded, when one was given or detected.' },
    default_branch: { type: 'string', description: 'Default branch recorded, when one was given or detected.' },
    registered: { type: 'boolean', description: 'True when the project was written.' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema
