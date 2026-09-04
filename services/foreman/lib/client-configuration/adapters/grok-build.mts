import { assertApplyPlan, assertRestorePlan, sameJson, selectModels } from '../adapter-common.mts'
import { applyFileTransaction, assertPlanDigest, readFileSnapshot } from '../files.mts'
import { patchOwnedToml, snapshotOwnedToml, tomlString, type OwnedTomlState } from '../toml-owned.mts'
import type {
  ClientAdapter,
  ClientConfigurationPlan,
  ClientConfigurationStatus,
  ClientGatewayModel,
  ClientModelSelection,
  ClientOwnershipRecord,
  ClientOwnershipStore,
  GatewayClientConnection,
  GatewayProtocol,
  JsonValue,
} from '../types.mts'

const PROTOCOL_PRIORITY: readonly GatewayProtocol[] = ['openai_responses', 'openai_chat', 'anthropic_messages']

interface GrokOwnedState {
  configExists: boolean
  config: OwnedTomlState
}

export interface GrokBuildAdapterOptions {
  configPath: string
  store: ClientOwnershipStore
  now?: () => string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function ownedState(value: JsonValue): GrokOwnedState {
  if (!isObject(value) || !isObject(value.config)) throw new Error('invalid Grok ownership state')
  return value as unknown as GrokOwnedState
}

function header(publicId: string): string {
  return `[model.${tomlString(`wrenyard:${publicId}`)}]`
}

function protocolFor(model: ClientGatewayModel, requested?: GatewayProtocol): GatewayProtocol {
  if (requested) {
    if (!model.protocols.includes(requested)) throw new Error(`model does not support ${requested}: ${model.publicId}`)
    return requested
  }
  const protocol = PROTOCOL_PRIORITY.find((candidate) => model.protocols.includes(candidate))
  if (!protocol) throw new Error(`model has no Grok-compatible gateway protocol: ${model.publicId}`)
  return protocol
}

function modelBlock(model: ClientGatewayModel, protocol: GatewayProtocol, connection: GatewayClientConnection): string {
  const baseUrl = protocol === 'openai_responses'
    ? connection.openaiResponsesBaseUrl
    : protocol === 'openai_chat'
      ? connection.openaiChatBaseUrl
      : connection.anthropicBaseUrl
  const backend = protocol === 'openai_responses' ? 'responses' : protocol === 'openai_chat' ? 'chat_completions' : 'messages'
  const lines = [
    header(model.publicId),
    `model = ${tomlString(model.publicId)}`,
    `base_url = ${tomlString(baseUrl)}`,
    `name = ${tomlString(`Wrenyard · ${model.provider} · ${model.displayName}`)}`,
    `api_backend = ${tomlString(backend)}`,
  ]
  if (protocol === 'anthropic_messages') {
    lines.push(`extra_headers = { x-api-key = ${tomlString(connection.credential)}, anthropic-version = "2023-06-01" }`)
  } else {
    lines.push(`api_key = ${tomlString(connection.credential)}`)
  }
  if (model.contextWindow) lines.push(`context_window = ${model.contextWindow}`)
  return lines.join('\n')
}

function asJson(state: GrokOwnedState): JsonValue {
  return state as unknown as JsonValue
}

export class GrokBuildAdapter implements ClientAdapter {
  readonly id = 'grok-build' as const
  private readonly now: () => string

  constructor(private readonly options: GrokBuildAdapterOptions) {
    this.now = options.now ?? (() => new Date().toISOString())
  }

  async status(): Promise<ClientConfigurationStatus> {
    const record = await this.options.store.get(this.id)
    if (!record) return { clientId: this.id, state: 'not-configured', configuredModels: [] }
    const expected = ownedState(record.lastApplied)
    const snapshot = await readFileSnapshot(this.options.configPath)
    const current: GrokOwnedState = {
      configExists: snapshot.exists,
      config: snapshotOwnedToml(snapshot.content, [], Object.keys(expected.config.tables)),
    }
    return {
      clientId: this.id,
      state: sameJson(current, expected) ? 'connected' : 'drifted',
      configuredModels: record.models,
    }
  }

  async plan(connection: GatewayClientConnection, selection: ClientModelSelection): Promise<ClientConfigurationPlan> {
    const models = selectModels(connection, selection, PROTOCOL_PRIORITY)
    const protocols = Object.fromEntries(models.map((model) => [
      model.publicId,
      protocolFor(model, selection.protocols?.[model.publicId]),
    ])) as Record<string, GatewayProtocol>
    const snapshot = await readFileSnapshot(this.options.configPath)
    const record = await this.options.store.get(this.id)
    const previousHeaders = record ? Object.keys(ownedState(record.lastApplied).config.tables) : []
    const nextHeaders = models.map((model) => header(model.publicId))
    return {
      clientId: this.id,
      operation: 'apply',
      files: [{
        path: snapshot.path,
        digest: snapshot.digest,
        existed: snapshot.exists,
        changes: [...new Set([...previousHeaders, ...nextHeaders])],
      }],
      models: [...selection.models],
      defaultModel: selection.defaultModel,
      protocols,
      connectionMode: 'additive',
      effects: ['新增 Wrenyard custom models', '保留 Grok 官方模型、默认项、登录与 allowlist'],
      requiresRestart: ['grok-build'],
    }
  }

  async apply(plan: ClientConfigurationPlan, connection: GatewayClientConnection): Promise<ClientConfigurationStatus> {
    assertApplyPlan(plan, this.id)
    const selection: ClientModelSelection = {
      models: plan.models,
      defaultModel: plan.defaultModel ?? '',
      protocols: plan.protocols,
    }
    const models = selectModels(connection, selection, PROTOCOL_PRIORITY)
    const snapshot = await readFileSnapshot(this.options.configPath)
    assertPlanDigest(snapshot, plan.files[0]?.digest ?? '')
    const record = await this.options.store.get(this.id)
    const previous = record ? ownedState(record.lastApplied) : undefined
    if (previous) {
      const current = {
        configExists: snapshot.exists,
        config: snapshotOwnedToml(snapshot.content, [], Object.keys(previous.config.tables)),
      }
      if (!sameJson(current, previous)) throw new Error('Grok owned model tables changed outside Wrenyard')
    }

    const desiredTables: Record<string, string | null> = {}
    for (const previousHeader of Object.keys(previous?.config.tables ?? {})) desiredTables[previousHeader] = null
    for (const model of models) {
      const protocol = protocolFor(model, selection.protocols?.[model.publicId])
      desiredTables[header(model.publicId)] = modelBlock(model, protocol, connection)
    }
    const touchedHeaders = Object.keys(desiredTables)
    const currentTouched = snapshotOwnedToml(snapshot.content, [], touchedHeaders)
    const existingBaseline = record ? ownedState(record.baseline) : { configExists: snapshot.exists, config: { topLevel: {}, tables: {} } }
    const baseline: GrokOwnedState = {
      configExists: existingBaseline.configExists,
      config: {
        topLevel: {},
        tables: { ...currentTouched.tables, ...existingBaseline.config.tables },
      },
    }
    const lastApplied: GrokOwnedState = {
      configExists: true,
      config: { topLevel: {}, tables: desiredTables },
    }
    const ownership: ClientOwnershipRecord = {
      clientId: this.id,
      baseline: asJson(baseline),
      lastApplied: asJson(lastApplied),
      models: [...plan.models],
      defaultModel: plan.defaultModel,
      updatedAt: this.now(),
    }
    await applyFileTransaction([
      { path: snapshot.path, content: patchOwnedToml(snapshot.content, lastApplied.config) },
    ], () => this.options.store.put(ownership))
    return { clientId: this.id, state: 'needs-restart', configuredModels: [...plan.models] }
  }

  async planRestore(): Promise<ClientConfigurationPlan> {
    const record = await this.requireRecord()
    const snapshot = await readFileSnapshot(this.options.configPath)
    return {
      clientId: this.id,
      operation: 'restore',
      files: [{
        path: snapshot.path,
        digest: snapshot.digest,
        existed: snapshot.exists,
        changes: ['restore Wrenyard-owned Grok model tables'],
      }],
      models: record.models,
      defaultModel: record.defaultModel,
      connectionMode: 'additive',
      effects: ['移除或恢复 Wrenyard-owned custom models', '保留所有非 owned Grok 配置'],
      requiresRestart: ['grok-build'],
    }
  }

  async restore(plan: ClientConfigurationPlan): Promise<ClientConfigurationStatus> {
    assertRestorePlan(plan, this.id)
    const record = await this.requireRecord()
    const expected = ownedState(record.lastApplied)
    const baseline = ownedState(record.baseline)
    const snapshot = await readFileSnapshot(this.options.configPath)
    assertPlanDigest(snapshot, plan.files[0]?.digest ?? '')
    const current = {
      configExists: snapshot.exists,
      config: snapshotOwnedToml(snapshot.content, [], Object.keys(expected.config.tables)),
    }
    if (!sameJson(current, expected)) throw new Error('Grok owned model tables changed outside Wrenyard')
    const restored = patchOwnedToml(snapshot.content, baseline.config)
    await applyFileTransaction([
      { path: snapshot.path, content: !baseline.configExists && restored.trim() === '' ? null : restored },
    ], () => this.options.store.remove(this.id))
    return { clientId: this.id, state: 'not-configured', configuredModels: [] }
  }

  private async requireRecord(): Promise<ClientOwnershipRecord> {
    const record = await this.options.store.get(this.id)
    if (!record) throw new Error('Grok Build is not configured by Wrenyard')
    return record
  }
}
