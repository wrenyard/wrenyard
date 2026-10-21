import { runTaskOutputCompile } from '@wrenyard/agent-loop'
import type { TaskRunCompileResult, TaskRunFacts } from '@wrenyard/protocol/task'
import { findTaskDefinition, resolveTaskTarget } from '../../workspace/definition-registry.mts'
import type { TaskOutputModelCallPort } from '../../daemon/execution/task-output-model-call.mts'
import type { TaskService } from './service.mts'

type JsonRecord = Record<string, unknown>

/** Compiles one existing run's report and facts into its output schema. */
export type TaskRunOutputCompiler = (taskRunId: string) => Promise<TaskRunCompileResult>

/** One run's recorded facts, or the empty shape when a run predates them. */
function recordedFacts(record: JsonRecord): TaskRunFacts {
  const facts = record['facts']
  if (facts !== null && typeof facts === 'object' && !Array.isArray(facts)) {
    return facts as TaskRunFacts
  }
  return {
    status: typeof record['status'] === 'string' ? record['status'] : 'unknown',
    duration_ms: null,
    timed_out: false,
    changed_files: [],
    commits: [],
    artifact_files: [],
  }
}

/**
 * The run's report: a plain output string, the `report` a failed compile
 * recorded next to its facts, or the run summary. Nothing is rephrased.
 */
function recordedReport(record: JsonRecord): string {
  const output = record['output']
  if (typeof output === 'string') return output
  if (output !== null && typeof output === 'object' && !Array.isArray(output)) {
    const report = (output as JsonRecord)['report']
    if (typeof report === 'string') return report
  }
  return typeof record['summary'] === 'string' ? record['summary'] : ''
}

/** The project the run was dispatched under, when the row recorded one. */
function recordedProject(record: JsonRecord): string | undefined {
  const meta = record['_meta']
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return undefined
  const project = (meta as JsonRecord)['project']
  return typeof project === 'string' && project !== '' ? project : undefined
}

/**
 * Run the task-output compile step for one existing run.
 *
 * The run's own report and the facts the daemon collected are compiled into the
 * task definition's output schema by one auxiliary loop. Nothing is compiled
 * twice and nothing is persisted: a compile failure returns the compile error
 * together with the report and the facts, never a retry.
 */
export function createTaskRunOutputCompiler(options: {
  workspaceRoot: string
  taskService: TaskService
  modelCall: TaskOutputModelCallPort
}): TaskRunOutputCompiler {
  return async (taskRunId: string): Promise<TaskRunCompileResult> => {
    const record = options.taskService.output(taskRunId)
    if (record === null) throw new Error(`Task run '${taskRunId}' not found`)
    const report = recordedReport(record)
    const facts = recordedFacts(record)
    const taskId = typeof record['task_id'] === 'string' ? record['task_id'] : ''
    const project = recordedProject(record)

    const definition = taskId === ''
      ? null
      : findTaskDefinition(taskId, options.workspaceRoot, project)
    const outputSchema = definition?.output_schema as Record<string, unknown> | boolean | undefined
    if (outputSchema === undefined || outputSchema === null) {
      return {
        task_run_id: taskRunId,
        ok: false,
        compile_error: `Task '${taskId}' declares no output schema to compile into`,
        report,
        facts,
      }
    }
    const target = taskId === ''
      ? null
      : resolveTaskTarget(taskId, options.workspaceRoot, project)
    const outputFacts = target?.definition.config.outputFacts

    const compiled = await runTaskOutputCompile({
      outputSchema,
      report,
      facts,
      ...(outputFacts === undefined ? {} : { outputFacts }),
      call: options.modelCall,
    })
    return compiled.ok
      ? { task_run_id: taskRunId, ok: true, output: compiled.output, report, facts }
      : { task_run_id: taskRunId, ok: false, compile_error: compiled.compileError, report, facts }
  }
}
