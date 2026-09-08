import type { TaskDefinition } from '../core/task/types.mts'
import exploreTask from './tasks/explore.mts'
import editTask from './tasks/edit.mts'
import testTask from './tasks/test.mts'
import exploreCodeTask from './tasks/explore-code.mts'
import exploreCommitTask from './tasks/explore-commit.mts'
import codeReviewTask from './tasks/code-review.mts'
import commitTask from './tasks/commit.mts'
import librarianTask from './tasks/librarian.mts'
import oracleTask from './tasks/oracle.mts'
import lookAtTask from './tasks/look-at.mts'
import prepareFixTask from './tasks/prepare-fix.mts'
import architectTask from './tasks/architect.mts'
import conformReviewTask from './tasks/conform-review.mts'
import exploreNotesTask from './tasks/explore-notes.mts'
import featurePointSynthesizeTask from './tasks/feature-point-synthesize.mts'
import fpReviewTask from './tasks/fp-review.mts'
import fuReviewTask from './tasks/fu-review.mts'
import functionalUnitBreakdownTask from './tasks/functional-unit-breakdown.mts'
import inquiryStepTask from './tasks/inquiry-step.mts'
import investigateTask from './tasks/investigate.mts'
import planReviewTask from './tasks/plan-review.mts'
import proposeDesignTask from './tasks/propose-design.mts'
import requestIntakeTask from './tasks/request-intake.mts'
import specReviewTask from './tasks/spec-review.mts'
import diagnoseReproTask from './tasks/diagnose-repro.mts'
import instrumentEvidenceTask from './tasks/instrument-evidence.mts'
import testHypothesisTask from './tasks/test-hypothesis.mts'
import verifyFixTask from './tasks/verify-fix.mts'
import writeFailingTestTask from './tasks/write-failing-test.mts'
import implementTask from './tasks/implement.mts'

/**
 * Foreman standard library — builtin task registry.
 *
 * `BUILTIN_TASKS` is the single source of truth for the builtin tasks
 * that the registry injects as a global builtin definition layer. Builtins
 * carry provenance `source: 'builtin'` and are not hosted under any project
 * namespace. The order and names below are fixed; downstream behavior
 * (resolution precedence, `list`/`describe` provenance) depends on
 * them staying in this exact shape.
 */

/** Sentinel sourcePath for builtin RegisteredTask entries (not a real file). */
export const BUILTIN_SOURCE_PATH = '(builtin)'

export interface BuiltinTaskEntry {
  /** Plain builtin task id (the unqualified name). */
  name: string
  /** The task definition authored under `lib/standard/tasks/<name>.mts`. */
  definition: TaskDefinition
}

// ─── Builtin task metadata ───────────────────────────────────────────────
//
// One authoritative, stable metadata record per builtin daily task: the
// existing human category plus a curated Chinese displayName. The metadata
// is definition metadata only — it is injected into each builtin config at
// index-build time and validated by the definition loader for project
// overrides. No substring inference and no duplicate mapping tables: the
// name → metadata table below is the single source of truth for builtin
// categories and display labels.

export interface TaskCategory {
  id: string
  displayLabel: string
}

/** Curated builtin task metadata injected into each builtin config at
 *  index-build time. `displayName` is authoritative human-facing display
 *  metadata only; it never changes the task id or resolution. */
export interface BuiltinTaskMetadata {
  category: TaskCategory
  displayName: string
}

const category = (id: string, displayLabel: string): TaskCategory => ({ id, displayLabel })

const CATEGORY = {
  edit: category('edit', '编码'),
  test: category('test', '测试'),
  'code-review': category('code-review', '代码审查'),
  explore: category('explore', '代码探索'),
  architecture: category('architecture', '架构分析'),
  commit: category('commit', '提交'),
  research: category('research', '资料研究'),
} as const

/**
 * The single authoritative builtin metadata map: every current builtin id
 * (including the legacy `implement` entry) maps to its existing category and
 * curated Chinese displayName. This is not a second task catalog — `BUILTIN_TASKS`
 * remains the fixed builtin registry and reads its category/displayName from here.
 */
export const BUILTIN_METADATA: Readonly<Record<string, BuiltinTaskMetadata>> = {
  explore: { category: CATEGORY.explore, displayName: '综合探索' },
  edit: { category: CATEGORY.edit, displayName: '编辑文件' },
  test: { category: CATEGORY.test, displayName: '运行验证' },
  'explore-code': { category: CATEGORY.explore, displayName: '代码探索' },
  'explore-commit': { category: CATEGORY.explore, displayName: '提交历史探索' },
  'code-review': { category: CATEGORY['code-review'], displayName: '代码质量审查' },
  commit: { category: CATEGORY.commit, displayName: '提交更改' },
  librarian: { category: CATEGORY.research, displayName: '资料研究' },
  oracle: { category: CATEGORY.architecture, displayName: '架构顾问' },
  'look-at': { category: CATEGORY.explore, displayName: '图像查看' },
  'prepare-fix': { category: CATEGORY.edit, displayName: '准备修复' },
  architect: { category: CATEGORY.architecture, displayName: '实施单元规划' },
  'conform-review': { category: CATEGORY['code-review'], displayName: '设计符合性审查' },
  'explore-notes': { category: CATEGORY.explore, displayName: '笔记探索' },
  'feature-point-synthesize': { category: CATEGORY.architecture, displayName: '功能点整理' },
  'fp-review': { category: CATEGORY['code-review'], displayName: '功能点评审' },
  'fu-review': { category: CATEGORY['code-review'], displayName: '功能单元评审' },
  'functional-unit-breakdown': { category: CATEGORY.architecture, displayName: '功能单元拆解' },
  'inquiry-step': { category: CATEGORY.research, displayName: '需求问询' },
  investigate: { category: CATEGORY.research, displayName: '问题调查' },
  'plan-review': { category: CATEGORY['code-review'], displayName: '实施计划评审' },
  'propose-design': { category: CATEGORY.architecture, displayName: '设计方案' },
  'request-intake': { category: CATEGORY.research, displayName: '需求受理' },
  'spec-review': { category: CATEGORY['code-review'], displayName: '规格评审' },
  'diagnose-repro': { category: CATEGORY.test, displayName: '诊断复现' },
  'instrument-evidence': { category: CATEGORY.test, displayName: '插桩取证' },
  'test-hypothesis': { category: CATEGORY.test, displayName: '假设验证' },
  'verify-fix': { category: CATEGORY.test, displayName: '修复验证' },
  'write-failing-test': { category: CATEGORY.test, displayName: '编写失败测试' },
  implement: { category: CATEGORY.edit, displayName: '实施（旧版）' },
}

/** Resolve the required builtin metadata for a known builtin task id. */
function builtinMetadataFor(name: string): BuiltinTaskMetadata {
  const metadata = BUILTIN_METADATA[name]
  if (!metadata) throw new Error(`Missing builtin metadata for '${name}'`)
  return metadata
}

/**
 * Return a shallow copy of the given task definition whose config carries
 * the declared builtin category and curated displayName. Only used at
 * index-build time; the module objects under `lib/standard/tasks/*.mts`
 * are never mutated.
 */
function withBuiltinMetadata<T extends TaskDefinition>(definition: T, metadata: BuiltinTaskMetadata): T {
  return {
    ...definition,
    config: {
      ...definition.config,
      category: metadata.category,
      displayName: metadata.displayName,
    },
  }
}

/** Resolve the builtin metadata (category + displayName) for a builtin task id. */
export function builtinTaskMetadata(name: string): BuiltinTaskMetadata | undefined {
  return BUILTIN_METADATA[name]
}

/** Resolve the builtin category for a builtin task id. */
export function builtinTaskCategory(name: string): TaskCategory | undefined {
  return BUILTIN_METADATA[name]?.category
}

/** Resolve the curated builtin displayName for a builtin task id. */
export function builtinTaskDisplayName(name: string): string | undefined {
  return BUILTIN_METADATA[name]?.displayName
}

/**
 * The builtin tasks, in fixed order:
 *   explore, edit, test, explore-code, explore-commit,
 *   code-review, commit, librarian, oracle, look-at, prepare-fix,
 *   architect, conform-review, explore-notes,
 *   feature-point-synthesize, fp-review, fu-review,
 *   functional-unit-breakdown, inquiry-step, investigate, plan-review,
 *   propose-design, request-intake, spec-review, diagnose-repro,
 *   instrument-evidence, test-hypothesis, verify-fix,
 *   implement, write-failing-test.
 */
export const BUILTIN_TASKS: readonly BuiltinTaskEntry[] = [
  { name: 'explore', definition: withBuiltinMetadata(exploreTask as TaskDefinition, builtinMetadataFor('explore')) },
  { name: 'edit', definition: withBuiltinMetadata(editTask as TaskDefinition, builtinMetadataFor('edit')) },
  { name: 'test', definition: withBuiltinMetadata(testTask as TaskDefinition, builtinMetadataFor('test')) },
  { name: 'explore-code', definition: withBuiltinMetadata(exploreCodeTask as TaskDefinition, builtinMetadataFor('explore-code')) },
  { name: 'explore-commit', definition: withBuiltinMetadata(exploreCommitTask as TaskDefinition, builtinMetadataFor('explore-commit')) },
  { name: 'code-review', definition: withBuiltinMetadata(codeReviewTask as TaskDefinition, builtinMetadataFor('code-review')) },
  { name: 'commit', definition: withBuiltinMetadata(commitTask as TaskDefinition, builtinMetadataFor('commit')) },
  { name: 'librarian', definition: withBuiltinMetadata(librarianTask as TaskDefinition, builtinMetadataFor('librarian')) },
  { name: 'oracle', definition: withBuiltinMetadata(oracleTask as TaskDefinition, builtinMetadataFor('oracle')) },
  { name: 'look-at', definition: withBuiltinMetadata(lookAtTask as TaskDefinition, builtinMetadataFor('look-at')) },
  { name: 'prepare-fix', definition: withBuiltinMetadata(prepareFixTask as TaskDefinition, builtinMetadataFor('prepare-fix')) },
  { name: 'architect', definition: withBuiltinMetadata(architectTask as TaskDefinition, builtinMetadataFor('architect')) },
  { name: 'conform-review', definition: withBuiltinMetadata(conformReviewTask as TaskDefinition, builtinMetadataFor('conform-review')) },
  { name: 'explore-notes', definition: withBuiltinMetadata(exploreNotesTask as TaskDefinition, builtinMetadataFor('explore-notes')) },
  { name: 'feature-point-synthesize', definition: withBuiltinMetadata(featurePointSynthesizeTask as TaskDefinition, builtinMetadataFor('feature-point-synthesize')) },
  { name: 'fp-review', definition: withBuiltinMetadata(fpReviewTask as TaskDefinition, builtinMetadataFor('fp-review')) },
  { name: 'fu-review', definition: withBuiltinMetadata(fuReviewTask as TaskDefinition, builtinMetadataFor('fu-review')) },
  { name: 'functional-unit-breakdown', definition: withBuiltinMetadata(functionalUnitBreakdownTask as TaskDefinition, builtinMetadataFor('functional-unit-breakdown')) },
  { name: 'inquiry-step', definition: withBuiltinMetadata(inquiryStepTask as TaskDefinition, builtinMetadataFor('inquiry-step')) },
  { name: 'investigate', definition: withBuiltinMetadata(investigateTask as TaskDefinition, builtinMetadataFor('investigate')) },
  { name: 'plan-review', definition: withBuiltinMetadata(planReviewTask as TaskDefinition, builtinMetadataFor('plan-review')) },
  { name: 'propose-design', definition: withBuiltinMetadata(proposeDesignTask as TaskDefinition, builtinMetadataFor('propose-design')) },
  { name: 'request-intake', definition: withBuiltinMetadata(requestIntakeTask as TaskDefinition, builtinMetadataFor('request-intake')) },
  { name: 'spec-review', definition: withBuiltinMetadata(specReviewTask as TaskDefinition, builtinMetadataFor('spec-review')) },
  { name: 'diagnose-repro', definition: withBuiltinMetadata(diagnoseReproTask as TaskDefinition, builtinMetadataFor('diagnose-repro')) },
  { name: 'instrument-evidence', definition: withBuiltinMetadata(instrumentEvidenceTask as TaskDefinition, builtinMetadataFor('instrument-evidence')) },
  { name: 'test-hypothesis', definition: withBuiltinMetadata(testHypothesisTask as TaskDefinition, builtinMetadataFor('test-hypothesis')) },
  { name: 'verify-fix', definition: withBuiltinMetadata(verifyFixTask as TaskDefinition, builtinMetadataFor('verify-fix')) },
  { name: 'implement', definition: withBuiltinMetadata(implementTask as TaskDefinition, builtinMetadataFor('implement')) },
  { name: 'write-failing-test', definition: withBuiltinMetadata(writeFailingTestTask as TaskDefinition, builtinMetadataFor('write-failing-test')) },
]

/** Set of builtin task names, for O(1) conflict checks during scan. */
export const BUILTIN_NAMES: ReadonlySet<string> = new Set(
  BUILTIN_TASKS.map((entry) => entry.name),
)
