#!/usr/bin/env node

/**
 * Self-contained canonical native FWA E2E runner.
 *
 * Exercises every Phase B operator path repeatably using a scripted Forge
 * executable that handles LLM calls deterministically while proxying all
 * non-LLM invocations to the real Forge CLI. TaskGraph and task execution
 * use production services — only the raw LLM response is scripted.
 *
 * Daemon lifecycle is driven exclusively through the `foreman daemon start|stop`
 * CLI contracts. No manual entry-point spawning or state-file invention.
 */

import { spawnSync } from 'node:child_process'
import { createServer, type AddressInfo } from 'node:net'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Allocate a free TCP port on localhost. */
async function allocatePort(): Promise<number> {
  return new Promise<number>((resolvePort, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      const port = addr.port
      server.close(() => resolvePort(port))
    })
    server.on('error', reject)
  })
}

interface CliResult {
  stdout: string
  stderr: string
  status: number | null
}

/**
 * Run foreman CLI via tsx with argv array and shell:false.
 * Returns parsed JSON when --json is used; throws on error.
 */
function foremanCli(args: string[], opts?: { env?: Record<string, string>; timeout?: number; noThrow?: boolean }): CliResult {
  const result = spawnSync(tsxPath, [foremanEntry, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...processEnvBase, ...opts?.env } as Record<string, string>,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    timeout: opts?.timeout ?? 60_000,
  })
  if (!opts?.noThrow && result.status !== 0) {
    const stderr = result.stderr?.toString().trim() ?? ''
    const stdout = result.stdout?.toString().trim() ?? ''
    throw new Error(`foreman ${args.join(' ')} exited ${result.status}: ${stderr}\nstdout: ${stdout}`)
  }
  return {
    stdout: result.stdout?.toString().trim() ?? '',
    stderr: result.stderr?.toString().trim() ?? '',
    status: result.status,
  }
}

function foremanJson(args: string[], opts?: { env?: Record<string, string>; timeout?: number }): unknown {
  const result = foremanCli(args, opts)
  try {
    return JSON.parse(result.stdout) as unknown
  } catch {
    throw new Error(`foreman ${args.join(' ')} output is not JSON:\n${result.stdout}`)
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const repoRoot = resolve(__dirname, '..')
const foremanEntry = resolve(repoRoot, 'bin', 'foreman.mts')
const tsxPath = resolve(repoRoot, 'node_modules', '.bin', 'tsx')
const fixtureDir = resolve(repoRoot, 'tests', 'fixtures')
const forgeFixtureSource = resolve(fixtureDir, 'fwa-native-e2e-forge.mjs')
const graphFixtureSource = resolve(fixtureDir, 'taskgraph-fwa-e2e.graph.json')

// Resolve real forge binary
let realForgePath: string
try {
  realForgePath = spawnSync('which', ['forge'], { stdio: ['ignore', 'pipe', 'pipe'] })
    .stdout?.toString().trim() || 'forge'
} catch {
  realForgePath = 'forge'
}

// Resolve sibling agent-workspace for workspace_root
const agentWorkspaceRoot = resolve(repoRoot, '..', 'agent-workspace')

// Runtime env — set by main() before any helper calls
let processEnvBase: Record<string, string> = {}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // ---- 1. Allocate temp directory and resources ----
  const tmpRoot = mkdtempSync(join(tmpdir(), 'fwa-native-e2e-'))
  const configDir = join(tmpRoot, 'config')
  const xdgStateDir = join(tmpRoot, 'xdg-state')
  const logDir = join(xdgStateDir, 'logs')

  mkdirSync(configDir, { recursive: true })
  mkdirSync(xdgStateDir, { recursive: true })
  mkdirSync(logDir, { recursive: true })

  // Assert agent-workspace has FWA.md (never auto-create)
  const workspaceFwaMd = join(agentWorkspaceRoot, 'FWA.md')
  if (!existsSync(workspaceFwaMd)) {
    throw new Error(`FWA.md must exist at ${workspaceFwaMd}; create it before running the E2E test`)
  }

  const configPath = join(configDir, 'foreman.json')
  const stateFilePath = join(xdgStateDir, 'fwa-e2e-state.json')
  const forgeExecPath = join(tmpRoot, 'forge')

  // Write the scripted forge executable wrapper
  writeFileSync(
    forgeExecPath,
    `#!/usr/bin/env node\nimport("${forgeFixtureSource}").catch((e) => { console.error(e); process.exit(1); })\n`,
    'utf-8',
  )
  spawnSync('chmod', ['+x', forgeExecPath], { stdio: 'inherit' })

  const allocatedPort = await allocatePort()

  // ---- 2. Generate JSON config with normalized keys ----
  const configJson = {
    service: {
      bind: `127.0.0.1:${allocatedPort}`,
      public_url: `http://127.0.0.1:${allocatedPort}`,
      ipc: {
        path: join(xdgStateDir, 'foreman.sock'),
      },
    },
    daily_session: {
      enabled: false,
      workspace: agentWorkspaceRoot,
      runtime: 'opencode',
      profile: 'cci',
    },
    fwa: {
      backend: 'native',
      workspace_root: agentWorkspaceRoot,
      llm: {
        model: 'foreman-public/fwa-e2e',
        turn_timeout_ms: 300_000,
      },
    },
    pet: {
      enabled: false,
    },
  }
  writeFileSync(configPath, JSON.stringify(configJson, null, 2) + '\n', 'utf-8')

  // ---- 3. Set base env ----
  processEnvBase = {
    XDG_STATE_HOME: xdgStateDir,
    FOREMAN_DB_PATH: join(xdgStateDir, 'foreman.db'),
    // Put the scripted forge first on PATH, save real forge path for the script
    PATH: `${tmpRoot}:${process.env.PATH ?? ''}`,
    FOREMAN_FORGE_BIN: forgeExecPath,
    FWA_E2E_REAL_FORGE: realForgePath,
    FWA_E2E_STATE: stateFilePath,
    FWA_E2E_GRAPH: graphFixtureSource,
  }

  const epochStart = Date.now()

  // ---- 4. Start Foreman daemon via CLI ----
  foremanCli(['daemon', 'start', '--config', configPath], { timeout: 30_000 })

  const daemonStartedAt = Date.now()

  try {
    // ---- 5. Assign ----
    const assignResult = foremanJson(
      ['fwa', 'assign', 'TICKET-E2E-001', 'foreman', 'Implement the E2E test fixture', '--config', configPath, '--json'],
      { timeout: 30_000 },
    )

    const saPayload = assignResult as Record<string, unknown>
    const session = saPayload.session as Record<string, unknown>
    const sessionId = session.id as string

    if (!sessionId) {
      throw new Error(`assign did not return a session id: ${JSON.stringify(assignResult)}`)
    }

    // ---- 6. Send second message via generic message send contract ----
    const queuedMessageText = 'Also check the secondary flow'
    foremanJson(
      ['message', 'send', '-m', queuedMessageText, '--sender', 'operator', '--to', 'foreman-agent', '--ticket', 'TICKET-E2E-001', '--project', 'foreman', '--config', configPath],
      { timeout: 30_000 },
    )

    // ---- 7. Assert immediate busy status queue_depth=1 ----
    const turnDeadline = Date.now() + 60_000
    let fwaStatus: unknown = null
    let queueDepth = 0
    while (Date.now() < turnDeadline) {
      await sleep(500)
      try {
        fwaStatus = foremanJson(['fwa', 'status', sessionId, '--config', configPath, '--json'], { timeout: 5_000 })
        const statusPayload = fwaStatus as Record<string, unknown>
        queueDepth = statusPayload.queue_depth as number ?? 0
        if (queueDepth >= 1) break
      } catch {
        // retry
      }
    }

    if (queueDepth < 1) {
      throw new Error(`queue_depth never reached >=1 (was ${queueDepth}); last status: ${JSON.stringify(fwaStatus)}`)
    }

    const turnStartedAt = Date.now()

    // ---- 8. Wait for TaskGraph done and task output ----
    const graphDoneDeadline = Date.now() + 120_000
    let graphStatusJson: unknown = null
    let graphEventsJson: unknown = null
    let graphNodeInspectJson: unknown = null
    let taskOutputJson: unknown = null
    let fwaFinalStatusJson: unknown = null
    let graphDone = false
    let finalTaskRefs: string[] = []

    while (Date.now() < graphDoneDeadline) {
      await sleep(1_000)
      try {
        fwaFinalStatusJson = foremanJson(['fwa', 'status', sessionId, '--config', configPath, '--json'], { timeout: 5_000 })
      } catch {
        continue
      }

      const fsVal = fwaFinalStatusJson as Record<string, unknown>
      const fwaInnerStatus = fsVal.status as string
      if (fwaInnerStatus === 'failed') {
        const lastError = (fsVal.last_error as string) ?? 'unknown error'
        throw new Error(`TaskGraph executor failed: ${lastError}\nDaemon logs: ${logDir}`)
      }
      const graphRefs = (fsVal.graph_refs as string[]) ?? []
      const taskRefs = (fsVal.task_refs as string[]) ?? []

      if (graphRefs.length === 0) continue

      for (const graphRef of graphRefs) {
        graphStatusJson = foremanJson(['taskgraph', 'status', JSON.stringify({ taskgraph_id: graphRef }), '--config', configPath], { timeout: 5_000 })
        const gdata = graphStatusJson as Record<string, unknown>
        const state = gdata.state as string

        if (state === 'paused' || state === 'cancelled') {
          // Immediately fetch diagnostics instead of polling to deadline
          graphEventsJson = foremanJson(
            ['taskgraph', 'events', JSON.stringify({ taskgraph_id: graphRef }), '--config', configPath],
            { timeout: 5_000 },
          )
          graphNodeInspectJson = foremanJson(
            ['taskgraph', 'node', 'inspect', JSON.stringify({ taskgraph_id: graphRef, node_id: 'verify' }), '--config', configPath],
            { timeout: 5_000 },
          )
          if (taskRefs.length > 0) {
            taskOutputJson = foremanJson(['task', 'output', taskRefs[0], '--config', configPath], { timeout: 5_000 })
          }
          const taskOutputVal = taskOutputJson as Record<string, unknown>
          const taskStatus = taskOutputVal?.status as string ?? ''
          const taskError = taskOutputVal?.error as string ?? ''
          throw new Error(
            `TaskGraph state is ${state}: graph ${graphRef} task_status=${taskStatus} task_error=${taskError}\nDaemon logs: ${logDir}`,
          )
        }

        if (state !== 'done') continue

        if (taskRefs.length === 0) {
          // FWA status may not have reconciled task_refs yet; continue outer poll loop
          break
        }

        graphDone = true
        finalTaskRefs = [...taskRefs]
        graphEventsJson = foremanJson(['taskgraph', 'events', JSON.stringify({ taskgraph_id: graphRef }), '--config', configPath], { timeout: 5_000 })
        graphNodeInspectJson = foremanJson(['taskgraph', 'node', 'inspect', JSON.stringify({ taskgraph_id: graphRef, node_id: 'verify' }), '--config', configPath], { timeout: 5_000 })

        if (taskRefs.length > 0) {
          taskOutputJson = foremanJson(['task', 'output', taskRefs[0], '--config', configPath], { timeout: 5_000 })
        }
        break
      }

      if (graphDone) break
    }

    if (!graphDone) {
      throw new Error('TaskGraph never reached done state within timeout')
    }

    const graphDoneAt = Date.now()

    if (finalTaskRefs.length === 0) {
      throw new Error(`TaskGraph done but task_refs is empty -- finalTaskRefs was never populated`)
    }

    // ---- 8b. Assert task output status exactly done ----
    const taskOutputVal = taskOutputJson as Record<string, unknown>
    if ((taskOutputVal.status as string) !== 'done') {
      throw new Error(`Task output status is ${taskOutputVal.status as string}, expected done`)
    }

    // ---- 8c. Assert graph events contain taskgraph.done and node.completed with matching task_run_id ----
    const eventsData = graphEventsJson as Record<string, unknown>
    const eventList = (eventsData.events ?? []) as Array<Record<string, unknown>>
    const hasTaskgraphDone = eventList.some((ev) => (ev.type as string) === 'taskgraph.done')
    const hasNodeCompleted = eventList.some((ev) => {
      return (ev.type as string) === 'taskgraph.node.completed' && (ev.refs?.task_run_id as string) != null
    })
    if (!hasTaskgraphDone) {
      throw new Error('Graph events missing taskgraph.done event')
    }
    if (!hasNodeCompleted) {
      throw new Error('Graph events missing node.completed event with task_run_id')
    }
    const nodeCompletedEvent = eventList.find((ev) => (ev.type as string) === 'taskgraph.node.completed')
    const nodeTaskRunId = nodeCompletedEvent?.refs?.task_run_id as string

    // ---- 8d. Assert node inspect run.state done with same task_run_id ----
    const nodeInspectData = graphNodeInspectJson as Record<string, unknown>
    const runState = (nodeInspectData.run?.state ?? '') as string
    if (runState !== 'done') {
      throw new Error(`Node inspect run.state is ${runState}, expected done`)
    }
    const inspectTaskRunId = nodeInspectData.run?.task_run_id as string
    if (inspectTaskRunId !== nodeTaskRunId) {
      throw new Error(`Node inspect task_run_id (${inspectTaskRunId}) does not match event task_run_id (${nodeTaskRunId})`)
    }
    const fwaTaskRef = finalTaskRefs[0]
    if (fwaTaskRef !== nodeTaskRunId) {
      throw new Error(`FWA task_ref (${fwaTaskRef}) does not match event task_run_id (${nodeTaskRunId})`)
    }

    // ---- 8e. Assert transcript FIFO order, queued message, and wake turn markers ----
    const transcriptResult = foremanJson(['fwa', 'transcript', sessionId, '--config', configPath, '--json'], { timeout: 10_000 })
    const trVal = transcriptResult as Record<string, unknown>
    const entries = (trVal.entries ?? []) as Array<Record<string, unknown>>

    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error(`Transcript is empty or invalid: ${JSON.stringify(transcriptResult)}`)
    }

    // Verify FIFO: seq values are strictly increasing and content contains queued message, taskgraph.started, taskgraph.done
    let prevSeq = -1
    let foundQueuedAfterAck = false
    let foundStarted = false
    let foundDone = false
    let ackSeen = false
    for (const entry of entries) {
      const seq = entry.seq as number
      if (seq <= prevSeq) {
        throw new Error(`Transcript FIFO violation: seq ${seq} <= prev ${prevSeq}`)
      }
      prevSeq = seq
      const content = (entry.content ?? '') as string
      if (!ackSeen && content === 'acknowledged') {
        ackSeen = true
        continue
      }
      if (ackSeen && !foundQueuedAfterAck && entry.role === 'human' && content === queuedMessageText) {
        foundQueuedAfterAck = true
      }
      if (content.includes('taskgraph.started')) foundStarted = true
      if (content.includes('taskgraph.done')) foundDone = true
    }

    if (!foundQueuedAfterAck) {
      throw new Error('Transcript missing queued message after first acknowledgement')
    }
    if (!foundStarted) {
      throw new Error('Transcript missing taskgraph.started wake turn')
    }
    if (!foundDone) {
      throw new Error('Transcript missing taskgraph.done wake turn')
    }

    const transcriptVerifiedAt = Date.now()

    // ---- 9. Phase C: SLOW_IDLE_MESSAGE_E2E — immediate acceptance vs eventual execution ----
    const slowIdleText = 'Process this slowly SLOW_IDLE_MESSAGE_E2E'
    const slowIdleSendStart = Date.now()
    foremanJson(
      ['message', 'send', '-m', slowIdleText, '--sender', 'operator', '--to', 'foreman-agent', '--ticket', 'TICKET-E2E-001', '--project', 'foreman', '--config', configPath],
      { timeout: 30_000 },
    )
    const slowIdleAcceptedAt = Date.now()
    const slowIdleAcceptanceMs = slowIdleAcceptedAt - slowIdleSendStart
    if (slowIdleAcceptanceMs >= 1200) {
      throw new Error(`SLOW_IDLE_MESSAGE_E2E acceptance took ${slowIdleAcceptanceMs}ms, expected <1200ms`)
    }

    // Poll transcript until the human turn and assistant ack appear
    const slowIdleDeadline = Date.now() + 60_000
    let slowIdleHumanFound = false
    let slowIdleAssistantFound = false
    while (Date.now() < slowIdleDeadline) {
      await sleep(500)
      try {
        const trResult = foremanJson(['fwa', 'transcript', sessionId, '--config', configPath, '--json'], { timeout: 5_000 })
        const trVal = trResult as Record<string, unknown>
        const entries = (trVal.entries ?? []) as Array<Record<string, unknown>>
        for (const entry of entries) {
          const content = (entry.content ?? '') as string
          if (entry.role === 'human' && content.includes('SLOW_IDLE_MESSAGE_E2E')) {
            slowIdleHumanFound = true
          }
          if (entry.role === 'assistant' && content.includes('slow idle message processed')) {
            slowIdleAssistantFound = true
          }
        }
        if (slowIdleHumanFound && slowIdleAssistantFound) break
      } catch {
        // retry
      }
    }

    if (!slowIdleHumanFound) {
      throw new Error('SLOW_IDLE_MESSAGE_E2E human turn not found in transcript')
    }
    if (!slowIdleAssistantFound) {
      throw new Error('SLOW_IDLE_MESSAGE_E2E assistant acknowledgement not found in transcript')
    }

    const slowIdleDoneAt = Date.now()

    // ---- 10. Reassign same happy ticket and assert session id is identical/queryable ----
    const reassignResult = foremanJson(
      ['fwa', 'assign', 'TICKET-E2E-001', 'foreman', 'Reassignment verification', '--config', configPath, '--json'],
      { timeout: 30_000 },
    )
    const raPayload = reassignResult as Record<string, unknown>
    const raSession = raPayload.session as Record<string, unknown>
    const raSessionId = raSession.id as string
    if (raSessionId !== sessionId) {
      throw new Error(`Reassigned session id (${raSessionId}) does not match original (${sessionId})`)
    }
    // Query via fwa list to verify it's queryable
    const listAfterReassign = foremanJson(['fwa', 'list', '--config', configPath, '--json'], { timeout: 10_000 }) as Record<string, unknown>
    const listSessions = (listAfterReassign.sessions as Array<Record<string, unknown>>) ?? []
    const foundReassigned = listSessions.some((s) => (s.id as string) === sessionId)
    if (!foundReassigned) {
      throw new Error(`Reassigned session ${sessionId} not found in fwa list`)
    }

    const reassignVerifiedAt = Date.now()

    // ---- 11. Out-of-scope tool-call session (via daemon state + prompt) ----
    const oosPrompt = 'Try out-of-scope project OUT_OF_SCOPE_E2E'

    try {
      foremanJson(
        ['fwa', 'assign', 'TICKET-E2E-OOS', 'foreman', oosPrompt, '--config', configPath, '--json'],
        { timeout: 30_000 },
      )
    } catch {
      // assign may fail depending on daemon state; continue
    }

    let oosSessionId: string | null = null
    let oosHasProjectError = false
    const oosDeadline = Date.now() + 120_000

    while (Date.now() < oosDeadline) {
      await sleep(1_000)
      try {
        const listResult = foremanJson(['fwa', 'list', '--config', configPath, '--json'], { timeout: 5_000 })
        const listVal = listResult as Record<string, unknown>
        const sessions = (listVal.sessions as Array<Record<string, unknown>>) ?? []
        for (const sess of sessions) {
          if ((sess.ticket_id as string) === 'TICKET-E2E-OOS') {
            oosSessionId = sess.id as string
            break
          }
        }
        if (!oosSessionId) continue
      } catch {
        continue
      }

      // Found OOS session; get its transcript
      try {
        const oosTrResult = foremanJson(
          ['fwa', 'transcript', oosSessionId, '--config', configPath, '--json'],
          { timeout: 5_000 },
        )
        const oosTrVal = oosTrResult as Record<string, unknown>
        const rawEntries = (oosTrVal.entries ?? []) as Array<Record<string, unknown>>

        if (!Array.isArray(rawEntries)) continue

        // Require a tool transcript entry with exact outside session project scope error
        oosHasProjectError = rawEntries.some((e) => {
          const content = (e.content ?? '') as string
          return content.includes('outside session project scope')
        })
        if (oosHasProjectError) break
      } catch {
        continue
      }
    }

    if (!oosHasProjectError) {
      throw new Error('OOS transcript missing tool entry with exact "outside session project scope" error')
    }

    const oosDoneAt = Date.now()

    // ---- Stop native daemon ----
    foremanCli(['daemon', 'stop', '--config', configPath], { noThrow: true, timeout: 15_000 })
    await sleep(1_000)

    const daemonStoppedAt = Date.now()

    // ---- Restart with opencode backend ----
    const opencodeConfig = {
      ...configJson,
      fwa: {
        ...configJson.fwa,
        backend: 'opencode',
      },
    }
    writeFileSync(configPath, JSON.stringify(opencodeConfig, null, 2) + '\n', 'utf-8')

    const opencodeEnv: Record<string, string> = {
      XDG_STATE_HOME: xdgStateDir,
      FOREMAN_DB_PATH: join(xdgStateDir, 'foreman.db'),
      PATH: process.env.PATH ?? '',
    }

    // Start opencode backend daemon
    foremanCli(['daemon', 'start', '--config', configPath], { env: opencodeEnv, timeout: 30_000 })

    const opencodeStartedAt = Date.now()

    // ---- Assert opencode: require healthy daemon status ----
    const opencodeHealthResult = foremanJson(
      ['status', '--config', configPath, '--json'],
      { env: opencodeEnv, timeout: 5_000 },
    )
    const healthVal = opencodeHealthResult as Record<string, unknown>
    if (healthVal.ok !== true || (healthVal.daemon as Record<string, unknown>)?.running !== true || (healthVal.ipc as Record<string, unknown>)?.ok !== true) {
      throw new Error(`Opencode daemon not fully healthy: ok=${healthVal.ok}, daemon.running=${(healthVal.daemon as Record<string, unknown>)?.running}, ipc.ok=${(healthVal.ipc as Record<string, unknown>)?.ok}`)
    }

    // Assert fwa list throws with FWA_BACKEND_NOT_NATIVE
    let opencodeFwaListThrew = false
    try {
      foremanJson(
        ['fwa', 'list', '--config', configPath, '--json'],
        { env: opencodeEnv, timeout: 5_000 },
      )
      throw new Error('fwa list succeeded when FWA_BACKEND_NOT_NATIVE was expected')
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e)
      if (errMsg.includes('FWA_BACKEND_NOT_NATIVE')) {
        opencodeFwaListThrew = true
      } else if (errMsg.includes('not supported')) {
        opencodeFwaListThrew = true
      } else {
        throw new Error(`fwa list error does not contain FWA_BACKEND_NOT_NATIVE: ${errMsg}`)
      }
    }
    if (!opencodeFwaListThrew) {
      throw new Error('fwa list did not throw FWA_BACKEND_NOT_NATIVE')
    }

    const opencodeVerifiedAt = Date.now()

    // ---- Stop opencode daemon ----
    foremanCli(['daemon', 'stop', '--config', configPath], { env: opencodeEnv, noThrow: true, timeout: 15_000 })

    // ---- Print concise JSON evidence ----
    const evidence = {
      summary: 'FWA Native E2E test results',
      sessionId,
      graphDone,
      taskOutputStatusDone: (taskOutputJson as Record<string, unknown>)?.status === 'done',
      taskgraphStartedFound: foundStarted,
      taskgraphDoneFound: foundDone,
      queuedMessageFound: foundQueuedAfterAck,
      slowIdleAcceptedUnder1200ms: slowIdleAcceptanceMs < 1200,
      slowIdleHumanTurnFound: slowIdleHumanFound,
      slowIdleAssistantAckFound: slowIdleAssistantFound,
      reassignSessionIdMatch: raSessionId === sessionId,
      oosSessionFound: !!oosSessionId,
      oosProjectGuardErrorFound: oosHasProjectError,
      opencodeHealthy: healthVal.ok === true && (healthVal.daemon as Record<string, unknown>)?.running === true && (healthVal.ipc as Record<string, unknown>)?.ok === true,
      opencodeFwaListThrewCorrectError: opencodeFwaListThrew,
      timings: {
        daemonStartElapsedMs: daemonStartedAt - epochStart,
        turnElapsedMs: turnStartedAt - epochStart,
        graphElapsedMs: graphDoneAt - epochStart,
        transcriptElapsedMs: transcriptVerifiedAt - epochStart,
        slowIdleAcceptanceMs,
        slowIdleDoneElapsedMs: slowIdleDoneAt - epochStart,
        reassignElapsedMs: reassignVerifiedAt - epochStart,
        oosElapsedMs: oosDoneAt - epochStart,
        daemonStopElapsedMs: daemonStoppedAt - epochStart,
        opencodeStartElapsedMs: opencodeStartedAt - epochStart,
        opencodeVerifyElapsedMs: opencodeVerifiedAt - epochStart,
        totalElapsedMs: opencodeVerifiedAt - epochStart,
      },
    }

    process.stdout.write(JSON.stringify(evidence, null, 2) + '\n')

  } finally {
    // ---- Cleanup: stop daemon and remove temp directory ----
    try {
      foremanCli(['daemon', 'stop', '--config', configPath], { noThrow: true, timeout: 10_000 })
    } catch {
      // ignore
    }
    rmSync(tmpRoot, { recursive: true, force: true })
  }
}

main().catch((err: unknown) => {
  console.error('\nFWA E2E FAILED:', err instanceof Error ? err.message : String(err))
  if (err instanceof Error && err.stack) {
    console.error(err.stack)
  }
  process.exit(1)
})
