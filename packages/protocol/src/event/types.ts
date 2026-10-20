import type { JsonRecord } from '../common/jsonrpc.ts'

export interface EventListParams {
  since?: number
  limit?: number
  /** Start at the current maximum event id when since is omitted. */
  tail?: boolean
}

export interface EventListResult {
  events: JsonRecord[]
  count: number
  cursor: number
}
