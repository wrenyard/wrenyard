import type { JsonRecord } from '../common/jsonrpc.ts'

export interface EventListParams {
  since?: number
  limit?: number
  /** Start at the current maximum event id when since is omitted. */
  tail?: boolean
  /**
   * Bounded server-side wait in milliseconds: when no events follow `since`,
   * the daemon blocks until a committed event insert wakes it or the deadline
   * passes, then answers. A deadline-expired idle wait returns the current
   * cursor without an extra DB read.
   */
  waitMs?: number
}

export interface EventListResult {
  events: JsonRecord[]
  count: number
  cursor: number
}
