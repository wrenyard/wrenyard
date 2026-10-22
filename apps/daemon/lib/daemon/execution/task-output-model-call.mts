import { randomUUID } from 'node:crypto'
import type { WrenyardGatewayConnection } from '@wrenyard/control'
import type { ProviderDefinition } from '@wrenyard/providers'
import type { ToolCall, ToolChoice, ToolSpec } from '@wrenyard/agent-loop'
import type { GatewayRouteStatus } from '@wrenyard/providers/base'
import type { ReasoningEffort } from '@wrenyard/models'
import {
  callModelAttempt,
  createModelTransport,
  settleWithAbort,
  type Message,
} from '@wrenyard/model-call'

/** One ranked auxiliary route and the level it is called at. */
export interface AuxiliaryRoute { model: string; reasoningEffort: ReasoningEffort }

/**
 * First-response timeout the task-output compile forwards to the Gateway
 * (seconds), matching the session auxiliary caller.
 */
const TASK_OUTPUT_FIRST_RESPONSE_TIMEOUT_SEC = 30

export type TaskOutputModelCallPort = (
  request: {
    messages: readonly Message[]
    tools: readonly ToolSpec[]
    toolChoice?: ToolChoice
    signal?: AbortSignal
  },
) => Promise<{ text: string; toolCalls: ToolCall[] }>

export function createTaskOutputModelCallPort(options: {
  gateway: () => Promise<WrenyardGatewayConnection>
  selectAuxiliary: (
    role: 'task-output',
    input?: { toolChoice?: ToolChoice },
  ) => Promise<readonly AuxiliaryRoute[]> | readonly AuxiliaryRoute[]
  resolveInferenceProvider: (providerId: string) => ProviderDefinition | undefined
  routeStatus?: (model: string) => GatewayRouteStatus | undefined
}): TaskOutputModelCallPort {
  const transport = createModelTransport({ gateway: options.gateway })
  const sessionId = `task-output-compile-${randomUUID()}`

  return async (request) => {
    // Only the task-output compile calls this port; any other role reaching it
    // is a wiring fault, not a routing decision.
    const signal = request.signal ?? AbortSignal.timeout(120_000)
    // Route selection is raced against the same signal so a cancellation
    // settles promptly and no model request is issued after it fires.
    const routes = await settleWithAbort(
      options.selectAuxiliary('task-output', {
        ...(request.toolChoice === undefined ? {} : { toolChoice: request.toolChoice }),
      }),
      signal,
    )
    const route = routes[0]
    if (route === undefined) {
      throw new Error('Auxiliary role task-output: no candidate qualified (empty route selection)')
    }
    const attempt = await callModelAttempt({
      transport,
      model: route.model,
      reasoningEffort: route.reasoningEffort,
      messages: request.messages,
      tools: request.tools,
      ...(request.toolChoice === undefined ? {} : { toolChoice: request.toolChoice }),
      attribution: { role: 'task-output', sessionId },
      firstResponseTimeoutSec: TASK_OUTPUT_FIRST_RESPONSE_TIMEOUT_SEC,
      attemptId: randomUUID(),
      signal,
      resolveProvider: options.resolveInferenceProvider,
    })
    return { text: attempt.result.text, toolCalls: attempt.result.toolCalls }
  }
}
