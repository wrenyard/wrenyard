import type { TaskDefinition } from '../core/task/types.mts'
import exploreTask from './tasks/explore.mts'
import editTask from './tasks/edit.mts'
import testTask from './tasks/test.mts'
import codeReviewTask from './tasks/code-review.mts'
import commitTask from './tasks/commit.mts'
import librarianTask from './tasks/librarian.mts'
import oracleTask from './tasks/oracle.mts'
import docTask from './tasks/doc.mts'

export const BUILTIN_SOURCE_PATH = '(builtin)'

export interface TaskCategory { id: string; displayLabel: string }
export interface BuiltinTaskMetadata { category: TaskCategory; displayName: string }
export interface BuiltinTaskEntry { name: string; definition: TaskDefinition }

/** Reusable delegation roles. Retired workflow stages have no hidden aliases. */
const catalog: readonly (BuiltinTaskEntry & BuiltinTaskMetadata)[] = [
  { name: 'explore', definition: exploreTask as TaskDefinition, category: { id: 'explore', displayLabel: '探索' }, displayName: '探索调查' },
  { name: 'edit', definition: editTask as TaskDefinition, category: { id: 'edit', displayLabel: '编码' }, displayName: '编辑文件' },
  { name: 'test', definition: testTask as TaskDefinition, category: { id: 'test', displayLabel: '测试' }, displayName: '运行验证' },
  { name: 'code-review', definition: codeReviewTask as TaskDefinition, category: { id: 'code-review', displayLabel: '审查' }, displayName: '变更审查' },
  { name: 'commit', definition: commitTask as TaskDefinition, category: { id: 'commit', displayLabel: '提交' }, displayName: '提交更改' },
  { name: 'librarian', definition: librarianTask as TaskDefinition, category: { id: 'research', displayLabel: '资料研究' }, displayName: '资料研究' },
  { name: 'oracle', definition: oracleTask as TaskDefinition, category: { id: 'architecture', displayLabel: '复杂分析' }, displayName: '分析顾问' },
]

/** Curated display metadata for the builtin document task. */
const DOC_METADATA: BuiltinTaskMetadata = {
  category: { id: 'doc', displayLabel: '文档' },
  displayName: '文档撰写',
}

/**
 * Frozen singleton definition for the trusted builtin document task.
 *
 * Trust is object identity — never name, display label, path, or hash. The
 * exact object reference exported here must be the one registered in
 * `BUILTIN_TASKS` and handed to execution. The config is frozen with it so the
 * standard `category`/`displayName` metadata cannot be mutated after
 * registration.
 */
export const TRUSTED_DOC_DEFINITION: TaskDefinition = Object.freeze({
  ...(docTask as TaskDefinition),
  config: Object.freeze({
    ...(docTask as TaskDefinition).config,
    category: DOC_METADATA.category,
    displayName: DOC_METADATA.displayName,
  }),
}) as unknown as TaskDefinition

/**
 * Trust the builtin document task by source plus strict object identity only.
 * A project override (or any other definition), even one reusing the `doc`
 * id, string-matching the source path, or reusing metadata, is never trusted.
 */
export function isTrustedDocDefinition(definition: TaskDefinition, source: unknown): boolean {
  return source === 'builtin' && definition === TRUSTED_DOC_DEFINITION
}

export const BUILTIN_METADATA: Readonly<Record<string, BuiltinTaskMetadata>> = Object.fromEntries([
  ...catalog.map(({ name, category, displayName }) => [name, { category, displayName }] as const),
  ['doc', DOC_METADATA] as const,
])

export function builtinTaskMetadata(name: string): BuiltinTaskMetadata | undefined {
  return BUILTIN_METADATA[name]
}
export function builtinTaskCategory(name: string): TaskCategory | undefined {
  return BUILTIN_METADATA[name]?.category
}
export function builtinTaskDisplayName(name: string): string | undefined {
  return BUILTIN_METADATA[name]?.displayName
}

export const BUILTIN_TASKS: readonly BuiltinTaskEntry[] = [
  ...catalog.map(({ name, definition, category, displayName }) => ({
    name,
    definition: { ...definition, config: { ...definition.config, category, displayName } },
  })),
  { name: 'doc', definition: TRUSTED_DOC_DEFINITION },
]
export const BUILTIN_NAMES: ReadonlySet<string> = new Set(BUILTIN_TASKS.map(({ name }) => name))
