/**
 * Exec DTOs for the raw prompt-execution API.
 *
 * An "execution" here is a single raw prompt handed to one resolved agent
 * client. The caller names a public model and client; the daemon resolves
 * the provider's dispatch plan before invoking exec. This package only
 * declares the wire contract; it does not resolve, route or persist requests.
 *
 * Design rules, all enforced by convention rather than by runtime validation:
 *
 * - Ids are OPAQUE non-empty strings. Never parse, order, or assume a format.
 * - Timestamps are epoch MILLISECONDS as plain numbers.
 * - Field names are camelCase.
 * - Only JSON-safe concrete shapes are used. No `Date`, `Error`, `Map`, `Set`,
 *   function, class instance, `undefined`-carrying required field, or native
 *   agent event object appears anywhere in this file.
 * - A snapshot deliberately exposes NO process, environment, or credential
 *   field. Events carry normalized client records and diagnostic stderr.
 *
 * These are TYPES ONLY and they DO NOT VALIDATE incoming JSON. See README.md.
 */

/** Epoch milliseconds since the Unix epoch. */
export type EpochMilliseconds = number

/** Opaque execution identifier. Non-empty on the wire. */
export type ExecId = string

/**
 * Per-execution monotonically increasing event sequence number.
 *
 * Events use positive safe integers starting at 1. A cursor may be 0 before
 * the first event. Sequence numbers are never reused within an execution.
 */
export type ExecSeq = number

/** Terminal-or-in-flight state of an execution. */
export type ExecStatus = 'running' | 'completed' | 'failed' | 'cancelled'

/** Identifiers of the configured execution features an exec request asks for. */
export type ExecFeatureId = string

/**
 * Bounded execution snapshot.
 *
 * Everything an exec caller needs to observe progress is here plus the event
 * stream: there is no `pid`, no `cwd`, no environment dump, no executable path
 * and no raw stderr. `error` carries a short human-readable failure reason and
 * is the only free-form field.
 */
export interface ExecSnapshot {
  id: ExecId
  /** Identifier of the agent client this execution was started against. */
  client: string
  status: ExecStatus
  createdAt: EpochMilliseconds
  /** Absent while the execution is `running`. */
  finishedAt?: EpochMilliseconds
  /**
   * Process exit code of the agent child, when the transport reported one.
   * `null` means the process was terminated by a signal or never produced an
   * exit code; the field itself is absent only while the execution runs.
   */
  exitCode?: number | null
  /** Present only when `status` is `failed` or `cancelled`. */
  error?: string
}

/**
 * One recorded execution event.
 *
 * `event` is the normalized agent record exactly as the owning client emitted
 * it, re-typed only as a JSON-compatible object. This package does not
 * interpret that record; consumers discriminate on its own fields, most
 * commonly its `type`.
 */
export interface ExecEventEnvelope {
  id: ExecId
  seq: ExecSeq
  event: import('../common/json.ts').JsonObject
}
