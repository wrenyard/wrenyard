import { REASONING_EFFORTS, type ReasoningEffort } from '@wrenyard/providers/catalog'
import type { JsonSchema } from '../jsonrpc.mts'

export interface GatewayConnectionParams {}

export interface GatewayConnectionResult {
  openaiChatBaseUrl: string
  openaiResponsesBaseUrl: string
  anthropicBaseUrl: string
  token: string
  models: Array<{
    id: string
    publicId: string
    provider: string
    /** Gateway protocols this exact model supports; the session picks its adapter from this list. */
    protocols: readonly ('openai_chat' | 'openai_responses' | 'anthropic_messages')[]
    displayName: string
    contextWindow?: number
    maxTokens?: number
    taskOnly?: boolean
    family?: 'claude'
    claudeTier?: 'haiku' | 'sonnet' | 'opus'
    supports1MContext?: boolean
    /** True when a verified, distinct upstream Fast mode exists for this route. */
    supportsFast?: boolean
    /** Catalog intelligence tier; absent when genuinely unknown (a route naming
     * no registered canonical model). */
    intelligence?: 'low' | 'mid' | 'high' | 'premium'
    maxOutputTokens?: number
    capabilities?: readonly ('text' | 'image')[]
    /**
     * The legal reasoning-effort levels this model accepts, in ascending
     * intensity. A per-run reasoning-effort choice is validated against this
     * exact ladder; an EMPTY ladder means no selectable level.
     */
    reasoningEfforts: readonly ReasoningEffort[]
    speed?: number
    /** USD per million tokens: [cached, input, output]. */
    pricing?: readonly [number, number, number]
    /** Current circuit state of the route; absent while it is healthy. */
    routeState?: 'rate_limited' | 'quota_exhausted' | 'auth_failed' | 'access_denied' | 'model_unavailable'
    routeUntil?: string
    routePhase?: 'closed' | 'open' | 'half_open'
    routeNextProbeAt?: string
    faultKind?: string
  }>
}

export const gatewayConnectionParamsSchema = {
  type: 'object', properties: {}, additionalProperties: false,
} as const satisfies JsonSchema

export const gatewayConnectionResultSchema = {
  type: 'object',
  required: ['openaiChatBaseUrl', 'openaiResponsesBaseUrl', 'anthropicBaseUrl', 'token', 'models'],
  properties: {
    openaiChatBaseUrl: { type: 'string', minLength: 1 },
    openaiResponsesBaseUrl: { type: 'string', minLength: 1 },
    anthropicBaseUrl: { type: 'string', minLength: 1 },
    token: { type: 'string', minLength: 1 },
    models: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'publicId', 'provider', 'protocols', 'displayName', 'reasoningEfforts'],
        properties: {
          id: { type: 'string' }, publicId: { type: 'string' }, provider: { type: 'string' },
          protocols: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: ['openai_chat', 'openai_responses', 'anthropic_messages'] } },
          displayName: { type: 'string' }, contextWindow: { type: 'integer', minimum: 1 }, maxTokens: { type: 'integer', minimum: 1 },
          taskOnly: { type: 'boolean' }, family: { const: 'claude' },
          claudeTier: { enum: ['haiku', 'sonnet', 'opus'] }, supports1MContext: { type: 'boolean' },
          supportsFast: { type: 'boolean' },
          intelligence: { enum: ['low', 'mid', 'high', 'premium'] },
          maxOutputTokens: { type: 'integer', minimum: 1 },
          capabilities: { type: 'array', items: { enum: ['text', 'image'] } },
          reasoningEfforts: {
            type: 'array', uniqueItems: true,
            items: { enum: REASONING_EFFORTS },
          },
          speed: { type: 'number', exclusiveMinimum: 0 },
          pricing: {
            type: 'array',
            minItems: 3,
            maxItems: 3,
            items: { type: 'number', minimum: 0 },
          },
          routeState: { enum: ['rate_limited', 'quota_exhausted', 'auth_failed', 'access_denied', 'model_unavailable'] },
          routeUntil: { type: 'string' },
          routePhase: { enum: ['closed', 'open', 'half_open'] },
          routeNextProbeAt: { type: 'string' },
          faultKind: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

// ── gateway.settings / gateway.settings.save ──────────────────────────
// IPC-only reading and updating of the persisted gateway access settings. The
// snapshot keeps the SAVED choice (what the next bind will use) separate from
// the EFFECTIVE connection the running daemon actually serves, so a saved
// change is never confused with a live one. Reading reports whether a token is
// persisted rather than returning a saved value that differs from the effective
// one; only the effective token is exposed, for copy/reveal.

/** How the gateway chooses the loopback port it binds. */
export type GatewayPortMode = 'random' | 'fixed'

/** The connection the running daemon currently serves (captured at bind time). */
export type GatewayEffectiveConnection = {
  host: string
  port: number
  openaiChatBaseUrl: string
  openaiResponsesBaseUrl: string
  anthropicBaseUrl: string
  /** The token the running daemon accepts right now. */
  token: string
}

export interface GatewaySettingsParams {}

export type GatewaySettingsResult = {
  /** Saved port choice; takes effect at the next bind. */
  savedPortMode: GatewayPortMode
  /** Saved fixed port; present only when `savedPortMode` is `fixed`. */
  savedPort?: number
  /** Whether a persisted token exists; the saved value is never returned. */
  tokenSaved: boolean
  /** True when the saved port choice differs from the choice used at this bind. */
  portChangePending: boolean
  /** True when the persisted token differs from the effective token. */
  tokenChangePending: boolean
  /** The connection the running daemon serves right now. */
  effective: GatewayEffectiveConnection
}

/** Port choice for a save. `fixed` requires a validated 1–65535 TCP port. */
export type GatewaySettingsPortChoice =
  | { mode: 'random' }
  | { mode: 'fixed'; port: number }

/** Persisted-token replacement: a caller-supplied value or a fresh CSPRNG one. */
export type GatewayTokenReplacement =
  | { kind: 'custom'; token: string }
  | { kind: 'generate' }

export interface GatewaySettingsSaveParams {
  /** Omit to keep the saved port choice unchanged. */
  port?: GatewaySettingsPortChoice
  /** Omit to keep the persisted token unchanged. */
  token?: GatewayTokenReplacement
  /** Explicit acknowledgement required before any token replacement. */
  confirmTokenReplacement?: boolean
}

export type GatewaySettingsSaveResult = GatewaySettingsResult & {
  ok: true
  /**
   * Present when a token replacement was persisted: the running gateway keeps
   * accepting the previous token until the next bind, after which existing
   * external clients must use the new credentials.
   */
  warning?: string
}

/**
 * Returned whenever a token replacement is persisted. The running daemon keeps
 * the previous effective token until the next bind.
 */
export const GATEWAY_TOKEN_REPLACEMENT_WARNING =
  'A new gateway token was saved. The running gateway keeps accepting the previous token until it restarts; after the next start existing external clients must be updated with the new credentials.'

const gatewayEffectiveConnectionSchema = {
  type: 'object',
  required: ['host', 'port', 'openaiChatBaseUrl', 'openaiResponsesBaseUrl', 'anthropicBaseUrl', 'token'],
  additionalProperties: false,
  properties: {
    host: { type: 'string', minLength: 1 },
    port: { type: 'integer', minimum: 1, maximum: 65535 },
    openaiChatBaseUrl: { type: 'string', minLength: 1 },
    openaiResponsesBaseUrl: { type: 'string', minLength: 1 },
    anthropicBaseUrl: { type: 'string', minLength: 1 },
    token: { type: 'string', minLength: 1 },
  },
} as const satisfies JsonSchema

export const gatewaySettingsParamsSchema = {
  type: 'object', properties: {}, additionalProperties: false,
} as const satisfies JsonSchema

export const gatewaySettingsResultSchema = {
  type: 'object',
  required: ['savedPortMode', 'tokenSaved', 'portChangePending', 'tokenChangePending', 'effective'],
  additionalProperties: false,
  properties: {
    savedPortMode: { enum: ['random', 'fixed'] },
    savedPort: { type: 'integer', minimum: 1, maximum: 65535 },
    tokenSaved: { type: 'boolean' },
    portChangePending: { type: 'boolean' },
    tokenChangePending: { type: 'boolean' },
    effective: gatewayEffectiveConnectionSchema,
  },
} as const satisfies JsonSchema

export const gatewaySettingsSaveParamsSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    // The range and the fixed-mode port requirement are enforced by the daemon
    // handler so an out-of-range or missing port is refused with a clear,
    // non-echoing message; the schema only pins the wire shape.
    port: {
      oneOf: [
        { type: 'object', required: ['mode'], additionalProperties: false, properties: { mode: { const: 'random' } } },
        { type: 'object', required: ['mode', 'port'], additionalProperties: false, properties: { mode: { const: 'fixed' }, port: { type: 'integer', minimum: 1, maximum: 65535 } } },
      ],
    },
    token: {
      oneOf: [
        { type: 'object', required: ['kind'], additionalProperties: false, properties: { kind: { const: 'generate' } } },
        { type: 'object', required: ['kind', 'token'], additionalProperties: false, properties: { kind: { const: 'custom' }, token: { type: 'string', minLength: 1, maxLength: 4096, pattern: '^[\\x21-\\x7e]+$' } } },
      ],
    },
    confirmTokenReplacement: { type: 'boolean' },
  },
} as const satisfies JsonSchema

export const gatewaySettingsSaveResultSchema = {
  type: 'object',
  required: ['ok', 'savedPortMode', 'tokenSaved', 'portChangePending', 'tokenChangePending', 'effective'],
  additionalProperties: false,
  properties: {
    ok: { const: true },
    savedPortMode: { enum: ['random', 'fixed'] },
    savedPort: { type: 'integer', minimum: 1, maximum: 65535 },
    tokenSaved: { type: 'boolean' },
    portChangePending: { type: 'boolean' },
    tokenChangePending: { type: 'boolean' },
    effective: gatewayEffectiveConnectionSchema,
    warning: { type: 'string', minLength: 1 },
  },
} as const satisfies JsonSchema
