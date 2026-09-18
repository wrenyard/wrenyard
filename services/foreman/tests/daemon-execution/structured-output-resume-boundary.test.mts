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
  // An observational task may launch with unrestricted YOLO tools. Corrections
  // are therefore bounded and restricted to the original native session:
  // the production collection boundary repairs malformed structured output
  // in-session (not by replaying the task), capped at the default three
  // corrections after the initial attempt.
  it('corrects malformed structured output in-session and bounds the total attempts', async () => {
    const workspace = makeTempDir('foreman-structured-once-')
    const projectDir = join(workspace, 'projects', 'app')
    writeFileSync(join(projectDir, 'observe.task.ts'), `export default defineTask({
  input: foremanSchemas.z.object({}),
  output: foremanSchemas.z.object({ result: foremanSchemas.z.string() }).strict(),
  prompt: () => 'observe something',
})\n`, 'utf-8')
    await discoverTasks(workspace)

    let agentStarts = 0
    const resumedSessions: Array<string | undefined> = []
    const malformedOutput = 'not a foreman delivery block'
    const primitives = {
      agent: async (_profile: string, _prompt: string, opts?: { resume?: string }): Promise<AgentResult> => {
        agentStarts += 1
        resumedSessions.push(opts?.resume)
        // Malformed output and no native session id: the boundary must not
        // start a fresh replay of the original task.
        return { output: malformedOutput, status: 'done' }
      },
    }

    await assert.rejects(
      executeTask('observe', {}, { workspaceRoot: workspace, primitives }),
      (error: unknown) => {
        assert.ok(error instanceof Error, `expected an Error, got ${String(error)}`)
        assert.match(error.message, /no resumable native session id/u)
        return true
      },
    )

    assert.equal(
      agentStarts,
      1,
      'without a resumable native session the boundary must not start a fresh-task replay',
    )
    assert.deepEqual(resumedSessions, [undefined])
  })

  it('issues the default three corrections when the original attempt exposes a resumable session', async () => {
    const workspace = makeTempDir('foreman-structured-corrections-')
    const projectDir = join(workspace, 'projects', 'app')
    writeFileSync(join(projectDir, 'observe.task.ts'), `export default defineTask({
  input: foremanSchemas.z.object({}),
  output: foremanSchemas.z.object({ result: foremanSchemas.z.string() }).strict(),
  prompt: () => 'observe something',
})\n`, 'utf-8')
    await discoverTasks(workspace)

    let agentStarts = 0
    const resumedSessions: Array<string | undefined> = []
    const primitives = {
      agent: async (_profile: string, _prompt: string, opts?: { resume?: string }): Promise<AgentResult> => {
        agentStarts += 1
        resumedSessions.push(opts?.resume)
        return { output: 'still not a foreman delivery block', status: 'done', nativeSessionId: 'native_observe' }
      },
    }

    await assert.rejects(
      executeTask('observe', {}, { workspaceRoot: workspace, primitives }),
      (error: unknown) => {
        assert.ok(error instanceof Error, `expected an Error, got ${String(error)}`)
        return true
      },
    )

    assert.equal(agentStarts, 4, 'initial attempt plus the default three in-session corrections')
    assert.deepEqual(
      resumedSessions,
      [undefined, 'native_observe', 'native_observe', 'native_observe'],
      'every correction must continue the original native session',
    )
  })
})
