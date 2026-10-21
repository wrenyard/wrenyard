import { randomUUID } from 'node:crypto'
import type { WrenyardGatewayConnection } from '@wrenyard/control'
import type { ProviderDefinition } from '@wrenyard/providers'
import type { ToolCall, ToolChoice, ToolSpec } from '@wrenyard/agent-loop'
import type { GatewayRouteStatus } from '@wrenyard/providers/base'
import {
  createCallRunner,
  createModelTransport,
  type AuxiliaryCallRole,
  type AuxiliaryRoute,
  type Message,
} from '@wrenyard/session'

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
    input?: { toolChoice?: import('@wrenyard/session').ToolChoice },
  ) => Promise<readonly AuxiliaryRoute[]> | readonly AuxiliaryRoute[]
  resolveInferenceProvider: (providerId: string) => ProviderDefinition | undefined
  routeStatus?: (model: string) => GatewayRouteStatus | undefined
}): TaskOutputModelCallPort {
  const runner = createCallRunner({
    transport: createModelTransport({ gateway: options.gateway }),
    selectAuxiliary: (role: AuxiliaryCallRole, input) => {
      if (role !== 'task-output') {
        throw new Error(`Unexpected auxiliary role '${role}' for task output compile`)
      }
      return options.selectAuxiliary('task-output', input)
    },
    resolveProvider: (providerId: string) => options.resolveInferenceProvider(providerId),
    ...(options.routeStatus === undefined ? {} : { routeStatus: options.routeStatus }),
    append: async () => {},
    sessionId: `task-output-compile-${randomUUID()}`,
  })

  return async (request) => {
    const signal = request.signal ?? AbortSignal.timeout(120_000)
    const result = await runner.run({
      spanId: `task_output_${randomUUID()}`,
      parent: 'task-output-compile',
      role: 'task-output',
      messages: request.messages,
      layers: {},
      tools: request.tools,
      ...(request.toolChoice === undefined ? {} : { toolChoice: request.toolChoice }),
      signal,
    })
    return { text: result.text, toolCalls: result.toolCalls }
  }
}
