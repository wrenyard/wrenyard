/**
 * Run record: the shared contract for one delegated run.
 *
 * Both kinds of delegation — an external `task` execution and an in-process
 * `auxiliary` run — map to this shape, so the ledger, the statistics store and
 * the trace surfaces can list them together. The type is pure and carries no
 * persistence detail: producers map their own run state onto it.
 */

import type { TaskUsage } from './task-run-metadata.ts'

export type RunRecordKind = 'task' | 'auxiliary'

/** Who asked for the run. */
export type RunRecordCallerOrigin = 'session' | 'bot' | 'cli' | 'unknown'

export interface RunRecordCaller {
  origin: RunRecordCallerOrigin
  id?: string
}

/** The route the run was actually resolved to. */
export interface RunRecordRoute {
  provider?: string
  model?: string
  effort?: string
}

export interface RunRecordTiming {
  createdAt: string
  startedAt?: string
  finishedAt?: string
}

export interface RunRecord {
  id: string
  kind: RunRecordKind
  /** Auxiliary role; absent on a task run. */
  role?: string
  /** Task id; absent on an auxiliary run. */
  taskId?: string
  caller?: RunRecordCaller
  route?: RunRecordRoute
  status: string
  timing: RunRecordTiming
  usage?: TaskUsage
  /** Result summary when the producer has one. */
  summary?: string
}
