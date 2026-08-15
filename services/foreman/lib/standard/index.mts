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
import deepResearchFetchTask from './tasks/deep-research-fetch.mts'
import deepResearchScopeTask from './tasks/deep-research-scope.mts'
import deepResearchSynthesizeTask from './tasks/deep-research-synthesize.mts'
import deepResearchVerifyTask from './tasks/deep-research-verify.mts'
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

// ─── Builtin task categories ─────────────────────────────────────────────
//
// One structured, stable human category per builtin daily task. The category
// is definition metadata only — it is injected into each builtin config at
// index-build time and validated by the definition loader for project
// overrides. No substring inference and no duplicate mapping tables: the
// name → category table below is the single source of truth for builtins.

export interface TaskCategory {
  id: string
  displayLabel: string
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

const BUILTIN_TASK_CATEGORIES: Readonly<Record<string, TaskCategory>> = {
  explore: CATEGORY.explore,
  edit: CATEGORY.edit,
  test: CATEGORY.test,
  'explore-code': CATEGORY.explore,
  'explore-commit': CATEGORY.explore,
  'code-review': CATEGORY['code-review'],
  commit: CATEGORY.commit,
  librarian: CATEGORY.research,
  oracle: CATEGORY.architecture,
  'look-at': CATEGORY.explore,
  'prepare-fix': CATEGORY.edit,
  architect: CATEGORY.architecture,
  'conform-review': CATEGORY['code-review'],
  'explore-notes': CATEGORY.explore,
  'feature-point-synthesize': CATEGORY.architecture,
  'fp-review': CATEGORY['code-review'],
  'fu-review': CATEGORY['code-review'],
  'functional-unit-breakdown': CATEGORY.architecture,
  'inquiry-step': CATEGORY.research,
  investigate: CATEGORY.research,
  'plan-review': CATEGORY['code-review'],
  'propose-design': CATEGORY.architecture,
  'request-intake': CATEGORY.research,
  'spec-review': CATEGORY['code-review'],
  'deep-research-fetch': CATEGORY.research,
  'deep-research-scope': CATEGORY.research,
  'deep-research-synthesize': CATEGORY.research,
  'deep-research-verify': CATEGORY.research,
  'diagnose-repro': CATEGORY.test,
  'instrument-evidence': CATEGORY.test,
  'test-hypothesis': CATEGORY.test,
  'verify-fix': CATEGORY.test,
  'write-failing-test': CATEGORY.test,
  implement: CATEGORY.edit,
}

/**
 * Return a shallow copy of the given task definition whose config carries
 * the declared builtin category. Only used at index-build time; the module
 * objects under `lib/standard/tasks/*.mts` are never mutated.
 */
function withCategory<T extends TaskDefinition>(definition: T, taskCategory: TaskCategory): T {
  return {
    ...definition,
    config: {
      ...definition.config,
      category: taskCategory,
    },
  }
}

/** Resolve the builtin category for a builtin task id. */
export function builtinTaskCategory(name: string): TaskCategory | undefined {
  return BUILTIN_TASK_CATEGORIES[name]
}

/**
 * The builtin tasks, in fixed order:
 *   explore, edit, test, explore-code, explore-commit,
 *   code-review, commit, librarian, oracle, look-at, prepare-fix,
 *   architect, conform-review, explore-notes,
 *   feature-point-synthesize, fp-review, fu-review,
 *   functional-unit-breakdown, inquiry-step, investigate, plan-review,
 *   propose-design, request-intake, spec-review, deep-research-fetch,
 *   deep-research-scope, deep-research-synthesize, deep-research-verify,
 *   diagnose-repro, instrument-evidence, test-hypothesis, verify-fix,
 *   implement, write-failing-test.
 */
export const BUILTIN_TASKS: readonly BuiltinTaskEntry[] = [
  { name: 'explore', definition: withCategory(exploreTask as TaskDefinition, CATEGORY.explore) },
  { name: 'edit', definition: withCategory(editTask as TaskDefinition, CATEGORY.edit) },
  { name: 'test', definition: withCategory(testTask as TaskDefinition, CATEGORY.test) },
  { name: 'explore-code', definition: withCategory(exploreCodeTask as TaskDefinition, CATEGORY.explore) },
  { name: 'explore-commit', definition: withCategory(exploreCommitTask as TaskDefinition, CATEGORY.explore) },
  { name: 'code-review', definition: withCategory(codeReviewTask as TaskDefinition, CATEGORY['code-review']) },
  { name: 'commit', definition: withCategory(commitTask as TaskDefinition, CATEGORY.commit) },
  { name: 'librarian', definition: withCategory(librarianTask as TaskDefinition, CATEGORY.research) },
  { name: 'oracle', definition: withCategory(oracleTask as TaskDefinition, CATEGORY.architecture) },
  { name: 'look-at', definition: withCategory(lookAtTask as TaskDefinition, CATEGORY.explore) },
  { name: 'prepare-fix', definition: withCategory(prepareFixTask as TaskDefinition, CATEGORY.edit) },
  { name: 'architect', definition: withCategory(architectTask as TaskDefinition, CATEGORY.architecture) },
  { name: 'conform-review', definition: withCategory(conformReviewTask as TaskDefinition, CATEGORY['code-review']) },
  { name: 'explore-notes', definition: withCategory(exploreNotesTask as TaskDefinition, CATEGORY.explore) },
  { name: 'feature-point-synthesize', definition: withCategory(featurePointSynthesizeTask as TaskDefinition, CATEGORY.architecture) },
  { name: 'fp-review', definition: withCategory(fpReviewTask as TaskDefinition, CATEGORY['code-review']) },
  { name: 'fu-review', definition: withCategory(fuReviewTask as TaskDefinition, CATEGORY['code-review']) },
  { name: 'functional-unit-breakdown', definition: withCategory(functionalUnitBreakdownTask as TaskDefinition, CATEGORY.architecture) },
  { name: 'inquiry-step', definition: withCategory(inquiryStepTask as TaskDefinition, CATEGORY.research) },
  { name: 'investigate', definition: withCategory(investigateTask as TaskDefinition, CATEGORY.research) },
  { name: 'plan-review', definition: withCategory(planReviewTask as TaskDefinition, CATEGORY['code-review']) },
  { name: 'propose-design', definition: withCategory(proposeDesignTask as TaskDefinition, CATEGORY.architecture) },
  { name: 'request-intake', definition: withCategory(requestIntakeTask as TaskDefinition, CATEGORY.research) },
  { name: 'spec-review', definition: withCategory(specReviewTask as TaskDefinition, CATEGORY['code-review']) },
  { name: 'deep-research-fetch', definition: withCategory(deepResearchFetchTask as TaskDefinition, CATEGORY.research) },
  { name: 'deep-research-scope', definition: withCategory(deepResearchScopeTask as TaskDefinition, CATEGORY.research) },
  { name: 'deep-research-synthesize', definition: withCategory(deepResearchSynthesizeTask as TaskDefinition, CATEGORY.research) },
  { name: 'deep-research-verify', definition: withCategory(deepResearchVerifyTask as TaskDefinition, CATEGORY.research) },
  { name: 'diagnose-repro', definition: withCategory(diagnoseReproTask as TaskDefinition, CATEGORY.test) },
  { name: 'instrument-evidence', definition: withCategory(instrumentEvidenceTask as TaskDefinition, CATEGORY.test) },
  { name: 'test-hypothesis', definition: withCategory(testHypothesisTask as TaskDefinition, CATEGORY.test) },
  { name: 'verify-fix', definition: withCategory(verifyFixTask as TaskDefinition, CATEGORY.test) },
  { name: 'implement', definition: withCategory(implementTask as TaskDefinition, CATEGORY.edit) },
  { name: 'write-failing-test', definition: withCategory(writeFailingTestTask as TaskDefinition, CATEGORY.test) },
]

/** Set of builtin task names, for O(1) conflict checks during scan. */
export const BUILTIN_NAMES: ReadonlySet<string> = new Set(
  BUILTIN_TASKS.map((entry) => entry.name),
)
