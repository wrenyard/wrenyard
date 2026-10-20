/**
 * Routine feature wire DTOs: the `routine.*` params/result surface and the
 * routine record shape. A routine belongs to a bot: when it becomes due it
 * wakes its owning bot agent with the routine prompt instead of sending into
 * a session.
 *
 * Declared independently of any runtime package: the shapes are structural and
 * describe exactly what crosses the IPC boundary. The daemon holds the runtime
 * JSON schemas that validate these.
 */

/** Lifecycle of one routine. */
export type RoutineState = 'active' | 'paused'

export interface RoutineRecord {
  /** 8 lowercase hex characters; unique among every stored routine. */
  id: string
  /** The bot this routine wakes when it fires. */
  botId: string
  /** Optional short name from the routine file. */
  name?: string
  /** 1..4000 characters; used verbatim as the wake text when it fires. */
  prompt: string
  /** Whole minutes between runs; 1..10080 (7 days). */
  intervalMinutes: number
  state: RoutineState
  /** ISO timestamp of creation. */
  createdAt: string
  /** ISO timestamp of the next due run; absent while paused. */
  nextRunAt?: string
  /** ISO timestamp of the most recent successful run. */
  lastRunAt?: string
  /** Message of the most recent failure. */
  lastError?: string
  /** Number of successful runs. */
  runCount: number
}

export interface RoutineListParams { botId?: string }
export interface RoutineListResult { routines: RoutineRecord[] }
export interface RoutineCreateParams {
  botId: string
  prompt: string
  intervalMinutes: number
  name?: string
}
export interface RoutineCreateResult { routine: RoutineRecord }
export interface RoutineUpdateParams {
  id: string
  state: 'active' | 'paused'
}
export interface RoutineUpdateResult { routine: RoutineRecord }
export interface RoutineRunParams { id: string }
export interface RoutineRunResult { routine: RoutineRecord }
export interface RoutineDeleteParams { id: string }
export interface RoutineDeleteResult { deleted: true }
