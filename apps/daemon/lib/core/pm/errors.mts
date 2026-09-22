export type PmErrorCode =
  | 'project_not_found'
  | 'ticket_not_found'
  | 'parent_ticket_not_found'
  | 'parent_must_be_main'
  | 'project_mismatch'
  | 'invalid_field_for_kind'
  | 'invalid_status_transition'
  | 'main_has_open_subtickets'
  | 'main_has_subtickets'
  | 'invalid_patch'

export class PmError extends Error {
  readonly code: PmErrorCode
  readonly details?: Record<string, unknown>
  readonly statusCode: number

  constructor(code: PmErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'PmError'
    this.code = code
    this.details = details
    this.statusCode = 400
  }
}
