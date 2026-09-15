import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { discoverTasks, resetRegistry } from '../../lib/workspace/task-loader.mts'
import { invalidateProjectCache } from '../../lib/core/project/loader.mts'
import type { AgentResult, ExecutionOptions, TaskRunSettingsResolver } from '../../lib/types.mts'
import { closeDb, initDb } from '../../lib/db/connection.mts'
import { DaemonTaskRunner } from '../../lib/daemon/execution/task-runner.mts'
import { resetForemanEventBusForTest } from '../../lib/events/event-bus.mts'

let tempDirs: string[] = []

function automaticSettingsResolver(): TaskRunSettingsResolver {
  return async () => ({
    mode: 'automatic',
    exactAgentRuntime: 'forge/test',
    dispatch: null,
    timeoutMs: null,
    sources: {
      selectionMode: 'builtin',
      explicitRuntime: 'builtin',
      timeoutMs: 'builtin',
      automatic: {},
    },
  })
}

function executeTask(name: string, input: unknown, opts: ExecutionOptions | string) {
  const normalized = typeof opts === 'string'
    ? { workspaceRoot: opts, currentProject: 'app' }
    : { currentProject: 'app', ...opts }
  if (!normalized.taskSettingsResolver) {
    normalized.taskSettingsResolver = automaticSettingsResolver()
  }
  return new DaemonTaskRunner().execute(name, input, normalized)
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const projectDir = join(dir, 'projects', 'app')
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(
    join(projectDir, 'app.fmproj'),
    'name: app\ndescription: Test application\n',
    'utf-8',
  )
  tempDirs.push(dir)
  return dir
}

beforeEach(() => {
  closeDb()
  initDb(':memory:')
  resetRegistry()
  invalidateProjectCache()
})

afterEach(() => {
  resetRegistry()
  invalidateProjectCache()
  closeDb()
  resetForemanEventBusForTest()
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs = []
})

describe('production structured-output resume boundary', () => {
  // An observational task declares no writeTargets (no repository write lock),
  // yet production always launches it with unrestricted YOLO tools. Because the
  // lock metadata cannot prove the attempt had no side effects, the production
  // collection boundary must start the agent exactly once and never auto-resume
  // after malformed structured output.
  it('starts an observational YOLO task exactly once on malformed structured output', async () => {
    const workspace = makeTempDir('foreman-structured-once-')
    const projectDir = join(workspace, 'projects', 'app')
    writeFileSync(join(projectDir, 'observe.task.ts'), `export default defineTask({
  input: foremanSchemas.z.object({}),
  output: foremanSchemas.z.object({ result: foremanSchemas.z.string() }).strict(),
  prompt: () => 'observe something',
})\n`, 'utf-8')
    await discoverTasks(workspace)

    let agentStarts = 0
    const malformedOutput = 'not a foreman delivery block'
    const primitives = {
      agent: async (_profile: string, _prompt: string): Promise<AgentResult> => {
        agentStarts += 1
        return { output: malformedOutput, status: 'done' }
      },
    }

    await assert.rejects(
      executeTask('observe', {}, { workspaceRoot: workspace, primitives }),
      (error: unknown) => {
        assert.ok(error instanceof Error, `expected an Error, got ${String(error)}`)
        return true
      },
    )

    assert.equal(
      agentStarts,
      1,
      'an observational YOLO task must start exactly once; the production boundary forces maxResumeAttempts 0',
    )
  })
})
