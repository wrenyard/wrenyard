/**
 * Exec-specific error data.
 *
 * Every variant is discriminated by `kind` and carries only the identifiers
 * relevant to it. These shapes are the `error.data` payload of a JSON-RPC
 * error response.
 *
 * NUMERIC MAPPING IS PENDING. This feature deliberately assigns NO numeric
 * wire code: inventing speculative codes would freeze an arbitrary choice into
 * the wire format. A runtime adapter must define the full mapping before this
 * protocol is integrated. Consumers should discriminate on `kind` and treat a
 * numeric code as transport detail.
 *
 * Note that a cursor that is AHEAD of an execution's latest sequence, and an
 * unknown feature id, are both rejected at the future adapter rather than
 * modeled as their own variant here: the first is a client bug the generic
 * invalid-params failure already covers, and the second is a configuration
 * failure the caller is expected to resolve before starting the execution.
 */

/** The addressed execution does not exist, or is no longer retained. */
export interface ExecNotFoundErrorData {
  kind: 'exec_not_found'
  id: string
}

/** The addressed agent client is unknown, or cannot run. */
export interface ExecClientUnavailableErrorData {
  kind: 'exec_client_unavailable'
  client: string
}

/**
 * The requested `afterSeq` is older than retained history: events were
 * trimmed to keep the replay buffer bounded. The client must discard local
 * event state and re-read the snapshot, because the gap can never be filled.
 */
export interface ExecCursorExpiredErrorData {
  kind: 'exec_cursor_expired'
  id: string
  /** Oldest sequence number still retained, when known. */
  oldestRetainedSeq?: number
}

/** An unknown execution-feature id was requested; nothing was spawned. */
export interface ExecFeatureUnknownErrorData {
  kind: 'exec_feature_unknown'
  features: readonly string[]
}

/** Discriminated union of all exec error data payloads. */
export type ExecErrorData =
  | ExecNotFoundErrorData
  | ExecClientUnavailableErrorData
  | ExecCursorExpiredErrorData
  | ExecFeatureUnknownErrorData

export type ExecErrorKind = ExecErrorData['kind']
