import type {
  ClientConfigurationPlan,
  ClientGatewayModel,
  ClientModelSelection,
  GatewayClientConnection,
  GatewayProtocol,
} from './types.mts'

export function assertApplyPlan(plan: ClientConfigurationPlan, clientId: ClientConfigurationPlan['clientId']): void {
  if (plan.clientId !== clientId || plan.operation !== 'apply') {
    throw new Error(`invalid apply plan for ${clientId}`)
  }
}

export function assertRestorePlan(plan: ClientConfigurationPlan, clientId: ClientConfigurationPlan['clientId']): void {
  if (plan.clientId !== clientId || plan.operation !== 'restore') {
    throw new Error(`invalid restore plan for ${clientId}`)
  }
}

export function selectModels(
  connection: GatewayClientConnection,
  selection: ClientModelSelection,
  protocol: GatewayProtocol | readonly GatewayProtocol[],
  predicate: (model: ClientGatewayModel) => boolean = () => true,
): ClientGatewayModel[] {
  const acceptedProtocols = new Set(Array.isArray(protocol) ? protocol : [protocol])
  if (selection.models.length === 0) throw new Error('at least one model must be selected')
  if (!selection.models.includes(selection.defaultModel)) throw new Error('default model must be selected')
  if (new Set(selection.models).size !== selection.models.length) throw new Error('selected models must be unique')
  const byId = new Map(connection.models.map((model) => [model.publicId, model]))
  return selection.models.map((publicId) => {
    const model = byId.get(publicId)
    if (!model || !predicate(model) || !model.protocols.some((candidate) => acceptedProtocols.has(candidate))) {
      throw new Error(`model is not available for this client: ${publicId}`)
    }
    return model
  })
}

export function stripV1(url: string): string {
  return url.replace(/\/v1\/?$/, '')
}

export function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
