import type { JsonSchema } from '../jsonrpc.mts'

export type PetLifecycleState = 'starting' | 'running' | 'stopping' | 'stopped' | 'failed'

export interface PetStatusParams {}
export interface PetControlParams {}

export interface PetStatusResult {
  state: PetLifecycleState
  enabled: boolean
  running: boolean
  transport: 'ipc-jsonrpc'
  command: string
  args: string[]
  cwd: string
  ipc_path?: string
  pid?: number
  started_at?: string
  stopped_at?: string
  last_error?: string
  last_exit_code?: number
  last_exit_signal?: string
}

export interface PetControlResult {
  ok: boolean
  status: PetStatusResult
}

export const petEmptyParamsSchema = {
  type: 'object',
  properties: {},
  additionalProperties: true,
} as const satisfies JsonSchema

export const petStatusParamsSchema = petEmptyParamsSchema
export const petStartParamsSchema = petEmptyParamsSchema
export const petStopParamsSchema = petEmptyParamsSchema
export const petRestartParamsSchema = petEmptyParamsSchema

export const petStatusResultSchema = {
  type: 'object',
  required: ['state', 'enabled', 'running', 'transport', 'command', 'args', 'cwd'],
  properties: {
    state: { enum: ['starting', 'running', 'stopping', 'stopped', 'failed'] },
    enabled: { type: 'boolean' },
    running: { type: 'boolean' },
    transport: { const: 'ipc-jsonrpc' },
    command: { type: 'string' },
    args: { type: 'array', items: { type: 'string' } },
    cwd: { type: 'string' },
    ipc_path: { type: 'string' },
    pid: { type: 'integer' },
    started_at: { type: 'string' },
    stopped_at: { type: 'string' },
    last_error: { type: 'string' },
    last_exit_code: { type: 'integer' },
    last_exit_signal: { type: 'string' },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const petControlResultSchema = {
  type: 'object',
  required: ['ok', 'status'],
  properties: {
    ok: { type: 'boolean' },
    status: petStatusResultSchema,
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const petStartResultSchema = petControlResultSchema
export const petStopResultSchema = petControlResultSchema
export const petRestartResultSchema = petControlResultSchema
