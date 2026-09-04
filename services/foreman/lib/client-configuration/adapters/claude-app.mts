import { assertApplyPlan, assertRestorePlan, sameJson, selectModels, stripV1 } from '../adapter-common.mts'
import { isAbsolute } from 'node:path'
import { applyFileTransaction, assertPlanDigest, readFileSnapshot } from '../files.mts'
import { jsonField, patchOwnedJson, snapshotOwnedJson, type OwnedJsonField } from '../json-owned.mts'
import type {
  ClientAdapter,
  ClientConfigurationPlan,
  ClientConfigurationStatus,
  ClientGatewayModel,
  ClientModelSelection,
  ClientOwnershipRecord,
  ClientOwnershipStore,
  GatewayClientConnection,
  JsonValue,
} from '../types.mts'

export const WRENYARD_CLAUDE_PROFILE_ID = '00000000-0000-4000-8000-000000575245'
const META_PATHS = [['appliedId'], ['entries']] as const

interface ClaudeAppOwnedState {
  metaExists: boolean
  appliedId: OwnedJsonField
  profileEntry: JsonValue | null
  profileExists: boolean
  profile: string | null
}

export interface ClaudeAppCapability {
  supported: boolean
  externallyManaged?: boolean
  detail?: string
}

export interface ClaudeAppAdapterOptions {
  metaPath: string
  profilePath: string
  store: ClientOwnershipStore
  capabilityProbe: () => Promise<ClaudeAppCapability>
  now?: () => string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function ownedState(value: JsonValue): ClaudeAppOwnedState {
  if (!isObject(value) || !isObject(value.appliedId)) throw new Error('invalid Claude App ownership state')
  return value as unknown as ClaudeAppOwnedState
}

function asJson(state: ClaudeAppOwnedState): JsonValue {
  return state as unknown as JsonValue
}

function metaProjection(content: string, path: string, exists: boolean): ClaudeAppOwnedState {
  const fields = snapshotOwnedJson(content, path, META_PATHS)
  const entries = fields.entries?.present && Array.isArray(fields.entries.value) ? fields.entries.value : []
  return {
    metaExists: exists,
    appliedId: fields.appliedId ?? { present: false },
    profileEntry: (entries as JsonValue[]).find((entry) => isObject(entry) && entry.id === WRENYARD_CLAUDE_PROFILE_ID) ?? null,
    profileExists: false,
    profile: null,
  }
}

function patchedMeta(content: string, path: string, appliedId: OwnedJsonField, profileEntry: JsonValue | null): string {
  const current = snapshotOwnedJson(content, path, META_PATHS)
  const entries = current.entries?.present && Array.isArray(current.entries.value)
    ? [...current.entries.value]
    : []
  const nextEntries = entries.filter((entry) => !isObject(entry) || entry.id !== WRENYARD_CLAUDE_PROFILE_ID)
  if (profileEntry) nextEntries.push(profileEntry)
  return patchOwnedJson(content, path, new Map([
    [['appliedId'], appliedId],
    [['entries'], jsonField(nextEntries)],
  ]))
}

function profileContent(connection: GatewayClientConnection, models: readonly ClientGatewayModel[]): string {
  if (!isAbsolute(connection.credentialHelperPath)) {
    throw new Error('Claude App credential helper path must be absolute')
  }
  const profile = {
    inferenceProvider: 'gateway',
    inferenceGatewayBaseUrl: stripV1(connection.anthropicBaseUrl),
    inferenceCredentialKind: 'helper-script',
    inferenceCredentialHelper: connection.credentialHelperPath,
    inferenceGatewayAuthScheme: 'x-api-key',
    modelDiscoveryEnabled: false,
    inferenceModels: models.map((model) => ({
      name: model.publicId,
      labelOverride: model.displayName,
      ...(model.claudeTier ? { family: model.claudeTier } : {}),
      ...(model.supports1MContext ? { supports1m: true } : {}),
    })),
  }
  return `${JSON.stringify(profile, null, 2)}\n`
}

export class ClaudeAppAdapter implements ClientAdapter {
  readonly id = 'claude-app' as const
  private readonly now: () => string

  constructor(private readonly options: ClaudeAppAdapterOptions) {
    this.now = options.now ?? (() => new Date().toISOString())
  }

  async status(): Promise<ClientConfigurationStatus> {
    const record = await this.options.store.get(this.id)
    if (!record) return { clientId: this.id, state: 'not-configured', configuredModels: [] }
    return {
      clientId: this.id,
      state: sameJson(await this.currentState(), ownedState(record.lastApplied)) ? 'connected' : 'drifted',
      configuredModels: record.models,
    }
  }

  async plan(connection: GatewayClientConnection, selection: ClientModelSelection): Promise<ClientConfigurationPlan> {
    await this.ensureCapability()
    const models = selectModels(connection, selection, 'anthropic_messages', (model) => model.claudeFamily === true)
    const [meta, profile] = await Promise.all([
      readFileSnapshot(this.options.metaPath),
      readFileSnapshot(this.options.profilePath),
    ])
    const record = await this.options.store.get(this.id)
    if (!record && profile.exists) throw new Error('Claude App Wrenyard profile id is already owned by another tool')
    const currentMeta = metaProjection(meta.content, meta.path, meta.exists)
    if (!record && currentMeta.profileEntry) throw new Error('Claude App Wrenyard profile id is already present in _meta.json')
    return {
      clientId: this.id,
      operation: 'apply',
      files: [
        { path: meta.path, digest: meta.digest, existed: meta.exists, changes: ['appliedId', `entries.${WRENYARD_CLAUDE_PROFILE_ID}`] },
        { path: profile.path, digest: profile.digest, existed: profile.exists, changes: ['Wrenyard 3P Gateway profile'] },
      ],
      models: models.map((model) => model.publicId),
      defaultModel: selection.defaultModel,
      connectionMode: 'switching',
      effects: ['Claude App 进入 3P Gateway 模式', '标准 Claude 模式不会同时处理对话'],
      requiresRestart: ['claude-app'],
    }
  }

  async apply(plan: ClientConfigurationPlan, connection: GatewayClientConnection): Promise<ClientConfigurationStatus> {
    assertApplyPlan(plan, this.id)
    await this.ensureCapability()
    const models = selectModels(connection, { models: plan.models, defaultModel: plan.defaultModel ?? '' }, 'anthropic_messages', (model) => model.claudeFamily === true)
    const [meta, profile] = await Promise.all([
      readFileSnapshot(this.options.metaPath),
      readFileSnapshot(this.options.profilePath),
    ])
    assertPlanDigest(meta, plan.files.find((file) => file.path === meta.path)?.digest ?? '')
    assertPlanDigest(profile, plan.files.find((file) => file.path === profile.path)?.digest ?? '')
    const record = await this.options.store.get(this.id)
    const current = await this.currentState()
    if (record && !sameJson(current, ownedState(record.lastApplied))) {
      throw new Error('Claude App owned profile changed outside Wrenyard')
    }
    const baseline = record ? ownedState(record.baseline) : current
    const renderedProfile = profileContent(connection, models)
    const lastApplied: ClaudeAppOwnedState = {
      metaExists: true,
      appliedId: jsonField(WRENYARD_CLAUDE_PROFILE_ID),
      profileEntry: { id: WRENYARD_CLAUDE_PROFILE_ID, name: 'Wrenyard' },
      profileExists: true,
      profile: renderedProfile,
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
      {
        path: meta.path,
        content: patchedMeta(meta.content, meta.path, lastApplied.appliedId, lastApplied.profileEntry),
      },
      { path: profile.path, content: renderedProfile },
    ], () => this.options.store.put(ownership))
    return { clientId: this.id, state: 'needs-restart', configuredModels: [...plan.models] }
  }

  async planRestore(): Promise<ClientConfigurationPlan> {
    const record = await this.requireRecord()
    const [meta, profile] = await Promise.all([
      readFileSnapshot(this.options.metaPath),
      readFileSnapshot(this.options.profilePath),
    ])
    return {
      clientId: this.id,
      operation: 'restore',
      files: [
        { path: meta.path, digest: meta.digest, existed: meta.exists, changes: ['restore _meta.json profile selection'] },
        { path: profile.path, digest: profile.digest, existed: profile.exists, changes: ['restore Wrenyard profile baseline'] },
      ],
      models: record.models,
      defaultModel: record.defaultModel,
      connectionMode: 'switching',
      effects: ['恢复首次接入前的 Claude App profile selection', '保留其他 configLibrary profiles'],
      requiresRestart: ['claude-app'],
    }
  }

  async restore(plan: ClientConfigurationPlan): Promise<ClientConfigurationStatus> {
    assertRestorePlan(plan, this.id)
    const record = await this.requireRecord()
    const expected = ownedState(record.lastApplied)
    const baseline = ownedState(record.baseline)
    const [meta, profile] = await Promise.all([
      readFileSnapshot(this.options.metaPath),
      readFileSnapshot(this.options.profilePath),
    ])
    assertPlanDigest(meta, plan.files.find((file) => file.path === meta.path)?.digest ?? '')
    assertPlanDigest(profile, plan.files.find((file) => file.path === profile.path)?.digest ?? '')
    if (!sameJson(await this.currentState(), expected)) throw new Error('Claude App owned profile changed outside Wrenyard')
    const restoredMeta = patchedMeta(meta.content, meta.path, baseline.appliedId, baseline.profileEntry)
    await applyFileTransaction([
      { path: meta.path, content: !baseline.metaExists && isEmptyMeta(restoredMeta) ? null : restoredMeta },
      { path: profile.path, content: baseline.profileExists ? baseline.profile : null },
    ], () => this.options.store.remove(this.id))
    return { clientId: this.id, state: 'not-configured', configuredModels: [] }
  }

  private async currentState(): Promise<ClaudeAppOwnedState> {
    const [meta, profile] = await Promise.all([
      readFileSnapshot(this.options.metaPath),
      readFileSnapshot(this.options.profilePath),
    ])
    const state = metaProjection(meta.content, meta.path, meta.exists)
    state.profileExists = profile.exists
    state.profile = profile.exists ? profile.content : null
    return state
  }

  private async ensureCapability(): Promise<void> {
    const capability = await this.options.capabilityProbe()
    if (capability.externallyManaged) throw new Error(capability.detail ?? 'Claude App configuration is externally managed')
    if (!capability.supported) throw new Error(capability.detail ?? 'Claude App 3P Gateway is not supported')
  }

  private async requireRecord(): Promise<ClientOwnershipRecord> {
    const record = await this.options.store.get(this.id)
    if (!record) throw new Error('Claude App is not configured by Wrenyard')
    return record
  }
}

function isEmptyMeta(content: string): boolean {
  const parsed = JSON.parse(content) as Record<string, unknown>
  return Object.keys(parsed).length === 1 && Array.isArray(parsed.entries) && parsed.entries.length === 0
}
