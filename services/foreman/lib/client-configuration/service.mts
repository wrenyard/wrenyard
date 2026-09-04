import type {
  ClientAdapter,
  ClientConfigurationId,
  ClientConfigurationPlan,
  ClientConfigurationStatus,
  ClientDiscovery,
  ClientModelSelection,
  ClientSurfaceDiscovery,
  GatewayConnectionSource,
} from './types.mts'

export interface ClientConfigurationSnapshot {
  surfaces: readonly ClientSurfaceDiscovery[]
  configurations: readonly ClientConfigurationStatus[]
  models: readonly import('./types.mts').ClientGatewayModel[]
}

export class ClientConfigurationService {
  private readonly adapters: ReadonlyMap<ClientConfigurationId, ClientAdapter>

  constructor(
    private readonly discovery: ClientDiscovery,
    adapters: readonly ClientAdapter[],
    private readonly gateway: GatewayConnectionSource,
  ) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]))
    if (this.adapters.size !== adapters.length) throw new Error('duplicate client configuration adapter')
  }

  async snapshot(): Promise<ClientConfigurationSnapshot> {
    const [surfaces, configurations, connection] = await Promise.all([
      this.discovery.list(),
      Promise.all([...this.adapters.values()].map((adapter) => adapter.status())),
      this.gateway.read(),
    ])
    return { surfaces, configurations, models: connection.models }
  }

  async plan(clientId: ClientConfigurationId, selection: ClientModelSelection): Promise<ClientConfigurationPlan> {
    return this.adapter(clientId).plan(await this.gateway.read(), selection)
  }

  async apply(plan: ClientConfigurationPlan): Promise<ClientConfigurationStatus> {
    return this.adapter(plan.clientId).apply(plan, await this.gateway.read())
  }

  async planRestore(clientId: ClientConfigurationId): Promise<ClientConfigurationPlan> {
    return this.adapter(clientId).planRestore()
  }

  async restore(plan: ClientConfigurationPlan): Promise<ClientConfigurationStatus> {
    if (plan.operation !== 'restore') throw new Error('restore requires a restore plan')
    return this.adapter(plan.clientId).restore(plan)
  }

  private adapter(clientId: ClientConfigurationId): ClientAdapter {
    const adapter = this.adapters.get(clientId)
    if (!adapter) throw new Error(`unknown client configuration adapter: ${clientId}`)
    return adapter
  }
}
