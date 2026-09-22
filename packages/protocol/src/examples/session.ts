/** Static protocol examples. No transport or session engine is invoked. */
import type {
  ProtocolRequest,
  ProtocolSuccessResponse,
  ProtocolTypedNotification,
} from '../index.ts'
import type { JsonRpcErrorResponse } from '../common/jsonrpc.ts'
import { SESSION_NOT_FOUND } from '../common/errors.ts'
import type { SessionErrorData } from '../session/errors.ts'
import type { SessionEvent } from '../session/events.ts'

const CREATED_AT = 1790040000000

export const sendRequest = {
  jsonrpc: '2.0',
  id: 'request-1',
  method: 'session.send',
  params: {
    sessionId: 'session-1',
    clientRequestId: 'send-1',
    text: 'Explain this workspace.',
    model: { providerId: 'codebuddy', modelId: 'deepseek-v4.1-flash' },
  },
} satisfies ProtocolRequest<'session.send'>

/** Acceptance, not generation completion. Retrying send-1 returns these ids. */
export const sendResponse = {
  jsonrpc: '2.0',
  id: sendRequest.id,
  result: {
    turn: {
      turnId: 'turn-1',
      sessionId: 'session-1',
      status: 'queued',
      model: sendRequest.params.model,
      createdAt: CREATED_AT,
    },
    userMessage: {
      messageId: 'message-user-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      role: 'user',
      text: sendRequest.params.text,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
  },
} satisfies ProtocolSuccessResponse<'session.send'>

export const eventsRequest = {
  jsonrpc: '2.0',
  id: 'request-2',
  method: 'session.events',
  params: { sessionId: 'session-1', afterSeq: 12 },
} satisfies ProtocolRequest<'session.events'>

export const messageEvent = {
  type: 'message.upserted',
  sessionId: 'session-1',
  seq: 13,
  occurredAt: CREATED_AT + 2000,
  message: {
    messageId: 'message-assistant-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    role: 'assistant',
    text: 'This workspace contains the application and shared packages.',
    createdAt: CREATED_AT + 2000,
    updatedAt: CREATED_AT + 2000,
  },
} satisfies SessionEvent

export const eventsResponse = {
  jsonrpc: '2.0',
  id: eventsRequest.id,
  result: { events: [messageEvent], nextSeq: 13, hasMore: false },
} satisfies ProtocolSuccessResponse<'session.events'>

/** Future push uses the same event shape. No subscription is implemented. */
export const notification = {
  jsonrpc: '2.0',
  method: 'session.event',
  params: messageEvent,
} satisfies ProtocolTypedNotification<'session.event'>

export const notFoundResponse = {
  jsonrpc: '2.0',
  id: 'request-3',
  error: {
    ...SESSION_NOT_FOUND,
    data: { kind: 'session_not_found', sessionId: 'missing-session' },
  },
} satisfies JsonRpcErrorResponse<SessionErrorData>
