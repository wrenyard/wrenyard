/**
 * Run record: the shared contract for one delegated run.
 *
 * Both kinds of delegation — an external `task` execution and an in-process
 * `auxiliary` run — map to this shape, so the ledger, the statistics store and
 * the trace surfaces can list them together. The type is pure and carries no
 * persistence detail: producers map their own run state onto it.
 */

import type { TaskUsage } from './run-metadata.ts'

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

/**
 * Plain input for {@link toAuxiliaryRunRecord}. The auxiliary loop hands this to
 * the host `recordAuxiliaryRun` port at the end of every finished auxiliary run;
 * the session engine turns it into a {@link RunRecord} and forwards it to the
 * daemon sink. Carries no persistence detail so every producer maps its own run
 * state onto it.
 */
export interface AuxiliaryRunRecordInput {
  /** Run record id: a unique id for this auxiliary run. */
  id: string
  /** Auxiliary role this run served (document, todo, vcs, project, ...). */
  role: string
  /** The session that owns this auxiliary run. */
  callerSessionId: string
  status: string
  /** The route the run was resolved to, when known. */
  route?: { provider?: string; model?: string; effort?: string }
  usage?: TaskUsage
  /** ISO timestamp the run started. */
  startedAt: string
  /** ISO timestamp the run finished. */
  finishedAt: string
  summary?: string
  /** Full auxiliary observation lines, uncapped on the run record. */
  observations?: string[]
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
  /** Full auxiliary observation lines when persisted. */
  observations?: string[]
}
