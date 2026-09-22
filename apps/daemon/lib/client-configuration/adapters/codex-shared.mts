import type { JsonValue } from '../types.mts'
import { assertApplyPlan, assertRestorePlan, sameJson, selectModels } from '../adapter-common.mts'
import { applyFileTransaction, assertPlanDigest, readFileSnapshot } from '../files.mts'
import { patchOwnedToml, snapshotOwnedToml, tomlString, tomlStringArray, type OwnedTomlState } from '../toml-owned.mts'
import type {
  ClientAdapter,
  ClientConfigurationPlan,
  ClientConfigurationStatus,
  ClientGatewayModel,
  ClientModelSelection,
  ClientOwnershipRecord,
  ClientOwnershipStore,
  GatewayClientConnection,
  JsonValue as OwnedJsonValue,
} from '../types.mts'

const TOP_LEVEL_KEYS = ['model_provider', 'model_catalog_json', 'model'] as const
const PROVIDER_TABLE = '[model_providers.wrenyard]'

interface CodexOwnedState {
  configExists: boolean
  config: OwnedTomlState
  catalogExists: boolean
  catalog: string | null
}

export interface CodexSharedAdapterOptions {
  configPath: string
  catalogPath: string
  store: ClientOwnershipStore
  now?: () => string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function ownedState(value: JsonValue): CodexOwnedState {
  if (!isObject(value) || !isObject(value.config)) throw new Error('invalid codex ownership state')
  return value as unknown as CodexOwnedState
}

function providerBlock(connection: GatewayClientConnection): string {
  return [
    PROVIDER_TABLE,
    'name = "Wrenyard"',
    `base_url = ${tomlString(connection.openaiResponsesBaseUrl)}`,
    'wire_api = "responses"',
    `auth = { command = ${tomlStringArray(connection.credentialHelperCommand)} }`,
  ].join('\n')
}

function desiredConfig(connection: GatewayClientConnection, options: CodexSharedAdapterOptions, defaultModel: string): OwnedTomlState {
  return {
    topLevel: {
      model_provider: 'model_provider = "wrenyard"',
      model_catalog_json: `model_catalog_json = ${tomlString(options.catalogPath)}`,
      model: `model = ${tomlString(defaultModel)}`,
    },
    tables: { [PROVIDER_TABLE]: providerBlock(connection) },
  }
}

function catalogContent(models: readonly ClientGatewayModel[]): string {
  return `${JSON.stringify({
    models: models.map((model, priority) => ({
      slug: model.publicId,
      display_name: model.displayName,
      description: `${model.displayName} via Wrenyard Model Gateway`,
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [
        { effort: 'low', description: 'Fast responses with lighter reasoning' },
        { effort: 'medium', description: 'Balanced reasoning for everyday tasks' },
        { effort: 'high', description: 'Greater reasoning depth for complex tasks' },
      ],
      shell_type: 'unified_exec',
      visibility: 'list',
      supported_in_api: true,
      priority,
      ...(model.contextWindow ? { context_window: model.contextWindow } : {}),
    })),
  }, null, 2)}\n`
}

function asJson(state: CodexOwnedState): OwnedJsonValue {
  return state as unknown as OwnedJsonValue
}

export class CodexSharedAdapter implements ClientAdapter {
  readonly id = 'codex-shared' as const
  private readonly now: () => string

  constructor(private readonly options: CodexSharedAdapterOptions) {
    this.now = options.now ?? (() => new Date().toISOString())
  }

  async status(): Promise<ClientConfigurationStatus> {
    const record = await this.options.store.get(this.id)
    if (!record) return { clientId: this.id, state: 'not-configured', configuredModels: [] }
    const current = await this.currentState(Object.keys(ownedState(record.lastApplied).config.tables))
    return {
      clientId: this.id,
      state: sameJson(current, ownedState(record.lastApplied)) ? 'connected' : 'drifted',
      configuredModels: record.models,
    }
  }

  async plan(connection: GatewayClientConnection, selection: ClientModelSelection): Promise<ClientConfigurationPlan> {
    selectModels(connection, selection, 'openai_responses')
    const [config, catalog] = await Promise.all([
      readFileSnapshot(this.options.configPath),
      readFileSnapshot(this.options.catalogPath),
    ])
    return {
      clientId: this.id,
      operation: 'apply',
      files: [
        { path: config.path, digest: config.digest, existed: config.exists, changes: [...TOP_LEVEL_KEYS, PROVIDER_TABLE] },
        { path: catalog.path, digest: catalog.digest, existed: catalog.exists, changes: ['Wrenyard model catalog'] },
      ],
      models: [...selection.models],
      defaultModel: selection.defaultModel,
      connectionMode: 'switching',
      effects: ['Codex App 与 Codex CLI 共用该配置', 'auth.json 保持不变'],
      requiresRestart: ['codex-app', 'codex-cli'],
    }
  }

  async apply(plan: ClientConfigurationPlan, connection: GatewayClientConnection): Promise<ClientConfigurationStatus> {
    assertApplyPlan(plan, this.id)
    const selection = { models: plan.models, defaultModel: plan.defaultModel ?? '' }
    const models = selectModels(connection, selection, 'openai_responses')
    const [config, catalog] = await Promise.all([
      readFileSnapshot(this.options.configPath),
      readFileSnapshot(this.options.catalogPath),
    ])
    assertPlanDigest(config, plan.files.find((file) => file.path === config.path)?.digest ?? '')
    assertPlanDigest(catalog, plan.files.find((file) => file.path === catalog.path)?.digest ?? '')

    const record = await this.options.store.get(this.id)
    if (record) {
      const expected = ownedState(record.lastApplied)
      const current = await this.currentState(Object.keys(expected.config.tables))
      if (!sameJson(current, expected)) throw new Error('Codex owned fields changed outside Wrenyard')
    }
    const desiredToml = desiredConfig(connection, this.options, selection.defaultModel)
    const desiredCatalog = catalogContent(models)
    const baseline: CodexOwnedState = record ? ownedState(record.baseline) : {
      configExists: config.exists,
      config: snapshotOwnedToml(config.content, TOP_LEVEL_KEYS, [PROVIDER_TABLE]),
      catalogExists: catalog.exists,
      catalog: catalog.exists ? catalog.content : null,
    }
    const lastApplied: CodexOwnedState = {
      configExists: true,
      config: desiredToml,
      catalogExists: true,
      catalog: desiredCatalog,
    }
    const ownership: ClientOwnershipRecord = {
      clientId: this.id,
      baseline: asJson(baseline),
      lastApplied: asJson(lastApplied),
      models: [...plan.models],
      defaultModel: selection.defaultModel,
      updatedAt: this.now(),
    }
    await applyFileTransaction([
      { path: config.path, content: patchOwnedToml(config.content, desiredToml) },
      { path: catalog.path, content: desiredCatalog },
    ], () => this.options.store.put(ownership))
    return { clientId: this.id, state: 'needs-restart', configuredModels: [...plan.models] }
  }

  async planRestore(): Promise<ClientConfigurationPlan> {
    const record = await this.requireRecord()
    const [config, catalog] = await Promise.all([
      readFileSnapshot(this.options.configPath),
      readFileSnapshot(this.options.catalogPath),
    ])
    return {
      clientId: this.id,
      operation: 'restore',
      files: [
        { path: config.path, digest: config.digest, existed: config.exists, changes: ['restore Codex owned fields'] },
        { path: catalog.path, digest: catalog.digest, existed: catalog.exists, changes: ['restore Wrenyard model catalog'] },
      ],
      models: record.models,
      defaultModel: record.defaultModel,
      connectionMode: 'switching',
      effects: ['恢复 Wrenyard 首次接入前的 Codex owned fields', '保留 auth.json 与非 owned fields'],
      requiresRestart: ['codex-app', 'codex-cli'],
    }
  }

  async restore(plan: ClientConfigurationPlan): Promise<ClientConfigurationStatus> {
    assertRestorePlan(plan, this.id)
    const record = await this.requireRecord()
    const expected = ownedState(record.lastApplied)
    const baseline = ownedState(record.baseline)
    const [config, catalog] = await Promise.all([
      readFileSnapshot(this.options.configPath),
      readFileSnapshot(this.options.catalogPath),
    ])
    assertPlanDigest(config, plan.files.find((file) => file.path === config.path)?.digest ?? '')
    assertPlanDigest(catalog, plan.files.find((file) => file.path === catalog.path)?.digest ?? '')
    if (!sameJson(await this.currentState(Object.keys(expected.config.tables)), expected)) {
      throw new Error('Codex owned fields changed outside Wrenyard')
    }
    const restoredConfig = patchOwnedToml(config.content, baseline.config)
    await applyFileTransaction([
      { path: config.path, content: !baseline.configExists && restoredConfig.trim() === '' ? null : restoredConfig },
      { path: catalog.path, content: baseline.catalogExists ? baseline.catalog : null },
    ], () => this.options.store.remove(this.id))
    return { clientId: this.id, state: 'not-configured', configuredModels: [] }
  }

  private async currentState(tableHeaders: readonly string[]): Promise<CodexOwnedState> {
    const [config, catalog] = await Promise.all([
      readFileSnapshot(this.options.configPath),
      readFileSnapshot(this.options.catalogPath),
    ])
    return {
      configExists: config.exists,
      config: snapshotOwnedToml(config.content, TOP_LEVEL_KEYS, tableHeaders),
      catalogExists: catalog.exists,
      catalog: catalog.exists ? catalog.content : null,
    }
  }

  private async requireRecord(): Promise<ClientOwnershipRecord> {
    const record = await this.options.store.get(this.id)
    if (!record) throw new Error('Codex is not configured by Wrenyard')
    return record
  }
}
