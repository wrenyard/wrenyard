import { assertApplyPlan, assertRestorePlan, sameJson, selectModels, stripV1 } from '../adapter-common.mts'
import { applyFileTransaction, assertPlanDigest, readFileSnapshot } from '../files.mts'
import { jsonField, patchOwnedJson, snapshotOwnedJson, type OwnedJsonState } from '../json-owned.mts'
import type {
  ClientAdapter,
  ClientConfigurationPlan,
  ClientConfigurationStatus,
  ClientModelSelection,
  ClientOwnershipRecord,
  ClientOwnershipStore,
  GatewayClientConnection,
  JsonValue,
} from '../types.mts'

const OWNED_PATHS = [
  ['env', 'ANTHROPIC_BASE_URL'],
  ['env', 'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY'],
  ['apiKeyHelper'],
] as const

interface ClaudeCodeOwnedState {
  fileExists: boolean
  values: OwnedJsonState
}

export interface ClaudeCodeCapability {
  supported: boolean
  detail?: string
}

export interface ClaudeCodeAdapterOptions {
  settingsPath: string
  store: ClientOwnershipStore
  capabilityProbe: () => Promise<ClaudeCodeCapability>
  now?: () => string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function ownedState(value: JsonValue): ClaudeCodeOwnedState {
  if (!isObject(value) || !isObject(value.values)) throw new Error('invalid Claude Code ownership state')
  return value as unknown as ClaudeCodeOwnedState
}

function shellCommand(command: readonly string[]): string {
  if (command.length === 0) throw new Error('Claude Code requires a credential helper command')
  return command.map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(' ')
}

function desired(connection: GatewayClientConnection): OwnedJsonState {
  return {
    'env.ANTHROPIC_BASE_URL': jsonField(stripV1(connection.anthropicBaseUrl)),
    'env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY': jsonField('1'),
    apiKeyHelper: jsonField(shellCommand(connection.credentialHelperCommand)),
  }
}

function valuesMap(state: OwnedJsonState): ReadonlyMap<readonly string[], OwnedJsonState[string]> {
  return new Map(OWNED_PATHS.map((path) => [path, state[path.join('.')]]))
}

function asJson(state: ClaudeCodeOwnedState): JsonValue {
  return state as unknown as JsonValue
}

function hasNonEmptyJson(content: string): boolean {
  const parsed = JSON.parse(content) as Record<string, unknown>
  const env = parsed.env
  if (env && typeof env === 'object' && !Array.isArray(env) && Object.keys(env).length === 0) delete parsed.env
  return Object.keys(parsed).length > 0
}

export class ClaudeCodeAdapter implements ClientAdapter {
  readonly id = 'claude-code' as const
  private readonly now: () => string

  constructor(private readonly options: ClaudeCodeAdapterOptions) {
    this.now = options.now ?? (() => new Date().toISOString())
  }

  async status(): Promise<ClientConfigurationStatus> {
    const record = await this.options.store.get(this.id)
    if (!record) return { clientId: this.id, state: 'not-configured', configuredModels: [] }
    const expected = ownedState(record.lastApplied)
    const current = await this.currentState()
    return {
      clientId: this.id,
      state: sameJson(current, expected) ? 'connected' : 'drifted',
      configuredModels: record.models,
    }
  }

  async plan(connection: GatewayClientConnection, selection: ClientModelSelection): Promise<ClientConfigurationPlan> {
    const capability = await this.options.capabilityProbe()
    if (!capability.supported) throw new Error(capability.detail ?? 'Claude Code gateway discovery is not supported')
    selectModels(connection, selection, 'anthropic_messages')
    const snapshot = await readFileSnapshot(this.options.settingsPath)
    return {
      clientId: this.id,
      operation: 'apply',
      files: [{
        path: snapshot.path,
        digest: snapshot.digest,
        existed: snapshot.exists,
        changes: OWNED_PATHS.map((path) => path.join('.')),
      }],
      models: [...selection.models],
      defaultModel: selection.defaultModel,
      connectionMode: 'switching',
      effects: ['新会话通过 Anthropic Messages Gateway 运行', '原 Claude 登录与凭据文件保持不变'],
      requiresRestart: ['claude-code'],
    }
  }

  async apply(plan: ClientConfigurationPlan, connection: GatewayClientConnection): Promise<ClientConfigurationStatus> {
    assertApplyPlan(plan, this.id)
    await this.ensureCapability()
    selectModels(connection, { models: plan.models, defaultModel: plan.defaultModel ?? '' }, 'anthropic_messages')
    const snapshot = await readFileSnapshot(this.options.settingsPath)
    assertPlanDigest(snapshot, plan.files[0]?.digest ?? '')
    const record = await this.options.store.get(this.id)
    const current = { fileExists: snapshot.exists, values: snapshotOwnedJson(snapshot.content, snapshot.path, OWNED_PATHS) }
    if (record && !sameJson(current, ownedState(record.lastApplied))) {
      throw new Error('Claude Code owned fields changed outside Wrenyard')
    }
    const baseline = record ? ownedState(record.baseline) : current
    const lastApplied: ClaudeCodeOwnedState = { fileExists: true, values: desired(connection) }
    const ownership: ClientOwnershipRecord = {
      clientId: this.id,
      baseline: asJson(baseline),
      lastApplied: asJson(lastApplied),
      models: [...plan.models],
      defaultModel: plan.defaultModel,
      updatedAt: this.now(),
    }
    await applyFileTransaction([
      { path: snapshot.path, content: patchOwnedJson(snapshot.content, snapshot.path, valuesMap(lastApplied.values)) },
    ], () => this.options.store.put(ownership))
    return { clientId: this.id, state: 'needs-restart', configuredModels: [...plan.models] }
  }

  async planRestore(): Promise<ClientConfigurationPlan> {
    const record = await this.requireRecord()
    const snapshot = await readFileSnapshot(this.options.settingsPath)
    return {
      clientId: this.id,
      operation: 'restore',
      files: [{ path: snapshot.path, digest: snapshot.digest, existed: snapshot.exists, changes: ['restore Claude Code owned fields'] }],
      models: record.models,
      defaultModel: record.defaultModel,
      connectionMode: 'switching',
      effects: ['恢复首次接入前的 Gateway owned fields', '保留其他 Claude Code 设置与原生登录'],
      requiresRestart: ['claude-code'],
    }
  }

  async restore(plan: ClientConfigurationPlan): Promise<ClientConfigurationStatus> {
    assertRestorePlan(plan, this.id)
    const record = await this.requireRecord()
    const expected = ownedState(record.lastApplied)
    const baseline = ownedState(record.baseline)
    const snapshot = await readFileSnapshot(this.options.settingsPath)
    assertPlanDigest(snapshot, plan.files[0]?.digest ?? '')
    const current = { fileExists: snapshot.exists, values: snapshotOwnedJson(snapshot.content, snapshot.path, OWNED_PATHS) }
    if (!sameJson(current, expected)) throw new Error('Claude Code owned fields changed outside Wrenyard')
    const restored = patchOwnedJson(snapshot.content, snapshot.path, valuesMap(baseline.values))
    await applyFileTransaction([
      { path: snapshot.path, content: !baseline.fileExists && !hasNonEmptyJson(restored) ? null : restored },
    ], () => this.options.store.remove(this.id))
    return { clientId: this.id, state: 'not-configured', configuredModels: [] }
  }

  private async currentState(): Promise<ClaudeCodeOwnedState> {
    const snapshot = await readFileSnapshot(this.options.settingsPath)
    return { fileExists: snapshot.exists, values: snapshotOwnedJson(snapshot.content, snapshot.path, OWNED_PATHS) }
  }

  private async ensureCapability(): Promise<void> {
    const capability = await this.options.capabilityProbe()
    if (!capability.supported) throw new Error(capability.detail ?? 'Claude Code gateway discovery is not supported')
  }

  private async requireRecord(): Promise<ClientOwnershipRecord> {
    const record = await this.options.store.get(this.id)
    if (!record) throw new Error('Claude Code is not configured by Wrenyard')
    return record
  }
}
