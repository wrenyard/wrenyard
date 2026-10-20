import { REASONING_EFFORTS } from '@wrenyard/providers/catalog'
import type { JsonSchema } from '../jsonrpc.mts'

export type {
  GatewayConnectionParams,
  GatewayConnection as GatewayConnectionResult,
  GatewayHealthParams,
  GatewayHealthResult,
  GatewayPortMode,
  GatewayEffectiveConnection,
  GatewaySettingsParams,
  GatewaySettings as GatewaySettingsResult,
  GatewayPortChoice as GatewaySettingsPortChoice,
  GatewayTokenReplacement,
  GatewaySettingsSaveInput as GatewaySettingsSaveParams,
  GatewaySettingsSaveResult,
} from '@wrenyard/protocol/gateway'

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
          routePhase: { enum: ['closed', 'open'] },
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

const gatewayHealthLastFailureSchema = {
  type: 'object',
  required: ['at', 'class', 'reason'],
  additionalProperties: false,
  properties: {
    at: { type: 'string', minLength: 1 },
    class: { type: 'string', minLength: 1 },
    reason: { type: 'string' },
  },
} as const satisfies JsonSchema

const gatewayHealthWindowSchema = {
  type: 'object',
  required: ['requests', 'successes', 'failures', 'cancelled', 'callerErrors', 'admissionRefusals'],
  additionalProperties: false,
  properties: {
    requests: { type: 'integer', minimum: 0 },
    successes: { type: 'integer', minimum: 0 },
    failures: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } },
    cancelled: { type: 'integer', minimum: 0 },
    callerErrors: { type: 'integer', minimum: 0 },
    admissionRefusals: { type: 'integer', minimum: 0 },
    medianFirstResponseMs: { type: 'number', minimum: 0 },
    medianTps: { type: 'number', minimum: 0 },
    lastSuccessAt: { type: 'string', minLength: 1 },
    lastFailure: gatewayHealthLastFailureSchema,
  },
} as const satisfies JsonSchema

const gatewayRouteStatusSchema = {
  type: 'object',
  required: ['state', 'until'],
  additionalProperties: false,
  properties: {
    state: { enum: ['rate_limited', 'quota_exhausted', 'auth_failed', 'access_denied', 'model_unavailable'] },
    until: { type: 'string', minLength: 1 },
    phase: { enum: ['closed', 'open'] },
    resets: { type: 'boolean' },
    faultKind: { type: 'string' },
  },
} as const satisfies JsonSchema

export const gatewayHealthParamsSchema = {
  type: 'object', properties: {}, additionalProperties: false,
} as const satisfies JsonSchema

const gatewayHealthProviderSchema = {
  type: 'object',
  required: ['provider', 'last1h', 'last24h'],
  additionalProperties: false,
  properties: {
    provider: { type: 'string', minLength: 1 },
    last1h: gatewayHealthWindowSchema,
    last24h: gatewayHealthWindowSchema,
  },
} as const satisfies JsonSchema

const gatewayHealthPoolSchema = {
  type: 'object',
  required: ['provider', 'pool', 'last1h', 'last24h'],
  additionalProperties: false,
  properties: {
    provider: { type: 'string', minLength: 1 },
    pool: { type: 'string', minLength: 1 },
    last1h: gatewayHealthWindowSchema,
    last24h: gatewayHealthWindowSchema,
  },
} as const satisfies JsonSchema

export const gatewayHealthResultSchema = {
  type: 'object',
  required: ['generatedAt', 'routes', 'providers', 'pools'],
  additionalProperties: false,
  properties: {
    generatedAt: { type: 'string', minLength: 1 },
    routes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['provider', 'model', 'last1h', 'last24h'],
        additionalProperties: false,
        properties: {
          provider: { type: 'string', minLength: 1 },
          model: { type: 'string', minLength: 1 },
          last1h: gatewayHealthWindowSchema,
          last24h: gatewayHealthWindowSchema,
          routeState: gatewayRouteStatusSchema,
        },
      },
    },
    providers: { type: 'array', items: gatewayHealthProviderSchema },
    pools: { type: 'array', items: gatewayHealthPoolSchema },
  },
} as const satisfies JsonSchema
