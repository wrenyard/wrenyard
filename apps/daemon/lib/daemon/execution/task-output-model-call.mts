import type { WrenyardGatewayConnection } from '@wrenyard/control'
import type { ToolCall, ToolChoice, ToolSpec } from '@wrenyard/agent-loop'
import type { ReasoningEffort } from '@wrenyard/models'
import {
  callModelAttempt,
  createModelTransport,
  settleWithAbort,
  type Message,
} from '@wrenyard/ai'

/** One ranked auxiliary route and the level it is called at. */
export interface AuxiliaryRoute { model: string; reasoningEffort: ReasoningEffort }

/**
 * Local first-response timeout the task-output compile uses (seconds), matching
 * the session auxiliary caller.
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
  resolveAuxiliaryModel: (
    role: 'task-output',
    input?: { toolChoice?: ToolChoice },
  ) => Promise<AuxiliaryRoute> | AuxiliaryRoute
}): TaskOutputModelCallPort {
  const transport = createModelTransport({ gateway: options.gateway })

  return async (request) => {
    // Only the task-output compile calls this port; any other role reaching it
    // is a wiring fault, not a routing decision.
    const signal = request.signal ?? AbortSignal.timeout(120_000)
    // Route selection is raced against the same signal so a cancellation
    // settles promptly and no model request is issued after it fires.
    const route = await settleWithAbort(
      options.resolveAuxiliaryModel('task-output', {
        ...(request.toolChoice === undefined ? {} : { toolChoice: request.toolChoice }),
      }),
      signal,
    )
    const connection = await options.gateway()
    const attempt = await callModelAttempt({
      transport,
      model: route.model,
      reasoningEffort: route.reasoningEffort,
      messages: request.messages,
      tools: request.tools,
      ...(request.toolChoice === undefined ? {} : { toolChoice: request.toolChoice }),
      firstResponseTimeoutSec: TASK_OUTPUT_FIRST_RESPONSE_TIMEOUT_SEC,
      signal,
      models: connection.models,
    })
    return { text: attempt.result.text, toolCalls: attempt.result.toolCalls }
  }
}
