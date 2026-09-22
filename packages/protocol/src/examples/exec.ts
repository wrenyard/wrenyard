/** Static exec protocol examples. No transport or execution engine is invoked. */
import type {
  ProtocolRequest,
  ProtocolSuccessResponse,
} from '../index.ts'
import type { ExecErrorData } from '../exec/errors.ts'

const CREATED_AT = 1790040000000

export const startRequest = {
  jsonrpc: '2.0',
  id: 'request-1',
  method: 'exec.start',
  params: {
    client: 'codex',
    provider: 'chatgpt',
    model: 'gpt-5-codex',
    mode: 'native',
    prompt: 'Summarize this workspace.',
    cwd: '/workspace',
    thinking: 'medium',
    features: ['browser'],
  },
} satisfies ProtocolRequest<'exec.start'>

/** Acceptance, not completion: the execution may still be running. */
export const startResponse = {
  jsonrpc: '2.0',
  id: startRequest.id,
  result: {
    execution: {
      id: 'exec-1',
      client: 'codex',
      status: 'running',
      createdAt: CREATED_AT,
    },
  },
} satisfies ProtocolSuccessResponse<'exec.start'>

export const eventsRequest = {
  jsonrpc: '2.0',
  id: 'request-2',
  method: 'exec.events',
  params: { id: 'exec-1', afterSeq: 0 },
} satisfies ProtocolRequest<'exec.events'>

/**
 * The event body is the normalized agent record, carried through uninterpreted.
 */
export const eventsResponse = {
  jsonrpc: '2.0',
  id: eventsRequest.id,
  result: {
    events: [
      { id: 'exec-1', seq: 1, event: { type: 'message', role: 'assistant', text: 'Done.' } },
      { id: 'exec-1', seq: 2, event: { type: 'exit', exitCode: 0, signal: null } },
    ],
    nextSeq: 2,
  },
} satisfies ProtocolSuccessResponse<'exec.events'>

export const getResponse = {
  jsonrpc: '2.0',
  id: 'request-3',
  result: {
    execution: {
      id: 'exec-1',
      client: 'codex',
      status: 'completed',
      createdAt: CREATED_AT,
      finishedAt: CREATED_AT + 4_000,
      exitCode: 0,
    },
  },
} satisfies ProtocolSuccessResponse<'exec.get'>

export const cancelResponse = {
  jsonrpc: '2.0',
  id: 'request-4',
  result: { id: 'exec-1', status: 'cancelled' },
} satisfies ProtocolSuccessResponse<'exec.cancel'>

/** A cursor older than retained history: the client must resynchronize. */
export const cursorExpiredError = {
  kind: 'exec_cursor_expired',
  id: 'exec-1',
  oldestRetainedSeq: 40,
} satisfies ExecErrorData

export const featureUnknownError = {
  kind: 'exec_feature_unknown',
  features: ['browser'],
} satisfies ExecErrorData
