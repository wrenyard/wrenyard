/**
 * Scripted Forge executable for native FWA E2E tests.
 *
 * For non-llm argv: proxies synchronously to FWA_E2E_REAL_FORGE with
 * inherited stdio/environment. Command-line arguments after the script
 * name are forwarded as-is.
 *
 * For llm: parses the OpenAI request body from JSON in the last argument
 * (args.at(-1)), NOT from stdin. Returns a deterministic OpenAI-compatible
 * response with tool_calls. State machine is persisted in the file path
 * at FWA_E2E_STATE (each forge invocation is a new process).
 *
 * JSON only on stdout; diagnostics on stderr.
 *
 * Usage (set by the E2E runner):
 *   export FWA_E2E_REAL_FORGE=/path/to/real/forge
 *   export FWA_E2E_STATE=/path/to/state.json
 *   node tests/fixtures/fwa-native-e2e-forge.mjs llm [args...]
 *
 * State machine (persisted in FWA_E2E_STATE file):
 *   happy (default):
 *     call 0 (costs 2500ms) -> tool_calls [taskgraph_create with template:default]
 *     call 1 -> parse latest tool message for taskgraph.id (direct {taskgraph:{id}} shape),
 *               returns taskgraph_signal {taskgraph_id, signal:{type:start_graph,input:{}}}
 *     call 2+ -> { role: "assistant", content: "acknowledged", finish_reason: "stop" }
 *   OUT_OF_SCOPE_E2E (when current request messages contain OUT_OF_SCOPE_E2E):
 *     Handled inline, not persisted in state stage.
 *     If no tool message has "outside session project scope" -> task_run to foremanx
 *     If tool message has the guard error -> final acknowledgement
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ---- State persistence helpers ----

function getStateFile() {
  const path = process.env.FWA_E2E_STATE
  if (!path) throw new Error('FWA_E2E_STATE is required')
  return path
}

function readState() {
  const stateFile = getStateFile()
  if (!existsSync(stateFile)) {
    return { callCount: 0, stage: 'happy' }
  }
  try {
    return JSON.parse(readFileSync(stateFile, 'utf-8'))
  } catch {
    return { callCount: 0, stage: 'happy' }
  }
}

function writeState(state) {
  writeFileSync(getStateFile(), JSON.stringify(state), 'utf-8')
}

// ---- llm handler ----

function handleLlm() {
  const args = process.argv.slice(2)

  // Parse the OpenAI request from the last argument (JSON)
  const jsonArg = args.at(-1)
  if (!jsonArg) {
    console.error('FWA_E2E_FORGE: llm subcommand requires a JSON argument as the last positional')
    process.exit(1)
  }

  let request
  try {
    request = JSON.parse(jsonArg)
  } catch (err) {
    console.error(`FWA_E2E_FORGE: failed to parse llm request JSON from args: ${err.message}`, err)
    process.exit(1)
  }

  const messages = request.messages ?? []
  const latestUserText = messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join(' ')

  const isOutOfScope = latestUserText.includes('OUT_OF_SCOPE_E2E')

  // SLOW_IDLE_MESSAGE_E2E — detect using only the last user message so transcript
  // history does not trigger false positives on later reassign/event turns.
  const lastUserMsg = messages.filter((m) => m.role === 'user').at(-1)
  const lastUserText = lastUserMsg ? (lastUserMsg.content ?? '') : ''
  const isSlowIdleMessage = lastUserText.includes('SLOW_IDLE_MESSAGE_E2E')

  const state = readState()
  const callIndex = state.callCount

  // Increment call count
  state.callCount = callIndex + 1

  // Build response — OOS handled inline, SLOW_IDLE handled first, not persisted in state stage
  let response
  if (isSlowIdleMessage) {
    const deadline = Date.now() + 2500
    while (Date.now() < deadline) {
      // busy-wait
    }
    response = {
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'acknowledged — slow idle message processed', tool_calls: null },
        finish_reason: 'stop',
      }],
    }
  } else if (isOutOfScope) {
    // Check if any tool message in current request already has the scope error
    const hasGuardError = messages.some((m) => {
      if (m.role === 'tool' && m.content) {
        return m.content.includes('outside session project scope')
      }
      return false
    })
    if (hasGuardError) {
      response = {
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'acknowledged — out-of-scope error received', tool_calls: null },
          finish_reason: 'stop',
        }],
      }
    } else {
      // Return one task_run to foremanx
      response = {
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_tr_oos_e2e',
              type: 'function',
              function: { name: 'task_run', arguments: JSON.stringify({ task_id: 'test', project: 'foremanx', input: {} }) },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      }
    }
  } else {
    response = buildHappyResponse(callIndex, state, messages)
  }

  // Persist updated state
  writeState(state)

  const output = JSON.stringify(response)
  process.stdout.write(output + '\n')
}

function buildHappyResponse(callIndex, state, messages) {
  if (callIndex === 0) {
    // First call: wait 2500ms, then return taskgraph_create with named template
    const deadline = Date.now() + 2500
    while (Date.now() < deadline) {
      // busy-wait
    }

    const toolCallId = `call_tg_create_e2e`
    return {
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: toolCallId,
                type: 'function',
                function: {
                  name: 'taskgraph_create',
                  arguments: JSON.stringify({
                    template: 'default',
                  }),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }
  }

  if (callIndex === 1) {
    // Second call: parse latest tool message for taskgraph.id, return taskgraph_signal
    // Find the latest tool message with a result containing taskgraph.id
    let taskgraphId = state.taskgraphId || 'not-yet-set'
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role === 'tool' && msg.content) {
        try {
          const parsed = JSON.parse(msg.content)  // direct shape: {taskgraph:{id}}
          if (parsed.taskgraph?.id) {
            taskgraphId = parsed.taskgraph.id
            state.taskgraphId = taskgraphId
            break
          }
        } catch {
          // skip non-JSON tool messages
        }
      }
    }

    const toolCallId = `call_tg_signal_e2e`
    return {
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: toolCallId,
                type: 'function',
                function: {
                  name: 'taskgraph_signal',
                  arguments: JSON.stringify({
                    taskgraph_id: taskgraphId,
                    signal: { type: 'start_graph', input: {} },
                  }),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }
  }

  // Subsequent calls: simple acknowledgement
  return {
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: 'acknowledged',
          tool_calls: null,
        },
        finish_reason: 'stop',
      },
    ],
  }
}

// ---- Main dispatch ----

const args = process.argv.slice(2)

if (args.length === 0) {
  // No args: proxy to real forge with --help
  const realForge = process.env.FWA_E2E_REAL_FORGE || 'forge'
  spawnSync(realForge, ['--help'], {
    stdio: 'inherit',
  })
  process.exit(0)
}

const subcommand = args[0]

if (subcommand === 'llm') {
  handleLlm()
} else {
  // Non-llm: proxy exact argv to real forge
  const realForge = process.env.FWA_E2E_REAL_FORGE
  if (!realForge) {
    console.error('FWA_E2E_FORGE: FWA_E2E_REAL_FORGE is required for non-llm subcommands')
    process.exit(1)
  }

  const result = spawnSync(realForge, args, {
    stdio: 'inherit',
    env: { ...process.env },
  })

  process.exit(result.status ?? 1)
}
