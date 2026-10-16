import type { JsonSchema } from '../jsonrpc.mts'
import type {
  OperationComponentAction,
  OperationComponentId,
  OperationComponentSnapshot,
} from '../../daemon/services/operation-components.mts'

// ─── components.list / components.action ─────────────────────────────────────
// Machine-local operation component status (agent-browser, Cua Driver) and the
// user-triggered lifecycle actions. A list check is read-only; an installation,
// an update, a repair or an operating-system permission request only ever
// happens through an explicit `components.action` call from Desktop Settings.

export type ComponentsListParams = Record<string, never>

export type ComponentsListResult = {
  components: OperationComponentSnapshot[]
}

export type ComponentsActionParams = {
  id: OperationComponentId
  action: OperationComponentAction
}

export type ComponentsActionResult = {
  component: OperationComponentSnapshot
}

export const componentsListParamsSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const satisfies JsonSchema

export const componentsActionParamsSchema = {
  type: 'object',
  required: ['id', 'action'],
  properties: {
    id: { type: 'string', enum: ['browser', 'desktop'] },
    action: {
      type: 'string',
      enum: [
        'refresh',
        'install',
        'update',
        'repair',
        'authorize',
        'uninstall',
        'enable',
        'disable',
        'login',
        'save-login',
        'clear-login',
      ],
    },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const operationComponentSnapshotSchema = {
  type: 'object',
  required: ['id', 'name', 'state', 'pinnedVersion', 'host', 'platform', 'arch', 'hints', 'actions'],
  properties: {
    id: { type: 'string', enum: ['browser', 'desktop'] },
    name: { type: 'string' },
    state: {
      type: 'string',
      enum: ['not-installed', 'installing', 'needs-authorization', 'ready', 'failed', 'unsupported', 'disabled'],
    },
    source: { type: 'string', enum: ['managed', 'external'] },
    version: { type: 'string' },
    pinnedVersion: { type: 'string' },
    path: { type: 'string' },
    host: { type: 'string' },
    platform: { type: 'string' },
    arch: { type: 'string' },
    checkedAt: { type: 'string' },
    progress: {
      type: 'object',
      required: ['phase'],
      properties: {
        phase: { type: 'string' },
        receivedBytes: { type: 'number', minimum: 0 },
        totalBytes: { type: 'number', minimum: 0 },
      },
      additionalProperties: false,
    },
    error: { type: 'string', maxLength: 1000 },
    runtimePresent: { type: 'boolean' },
    hints: {
      type: 'array',
      items: {
        type: 'string',
        enum: [
          'legacy-browser-mcp',
          'shared-browser-runtime',
          'external-mcp',
          'existing-installation',
          'missing-accessibility',
          'missing-screen-recording',
          'screen-locked',
          'no-gui-session',
        ],
      },
    },
    actions: {
      type: 'array',
      items: {
        type: 'string',
        enum: [
          'refresh',
          'install',
          'update',
          'repair',
          'authorize',
          'uninstall',
          'enable',
          'disable',
          'login',
          'save-login',
          'clear-login',
        ],
      },
    },
    loginState: {
      type: 'object',
      required: ['domains', 'savedAt'],
      properties: {
        domains: { type: 'array', items: { type: 'string' } },
        savedAt: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const componentsListResultSchema = {
  type: 'object',
  required: ['components'],
  properties: {
    components: {
      type: 'array',
      items: operationComponentSnapshotSchema,
    },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const componentsActionResultSchema = {
  type: 'object',
  required: ['component'],
  properties: {
    component: operationComponentSnapshotSchema,
  },
  additionalProperties: false,
} as const satisfies JsonSchema
