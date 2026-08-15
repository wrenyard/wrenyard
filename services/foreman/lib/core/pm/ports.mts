import type { PmTicket, PmTicketStatus, PmTicketKind } from './ticket/model.mts'

export interface PmTicketFilter {
  project_id: string
  kind?: PmTicketKind
  status?: PmTicketStatus
  parent_id?: string
  assignee_session_id?: string
}

export interface PmTicketRepository {
  get(id: string): PmTicket | undefined
  insert(ticket: PmTicket): void
  list(filter: PmTicketFilter): PmTicket[]
  update(ticket: PmTicket): void
  delete(id: string): void
  countChildren(parentId: string): number
  listOpenSubticketIds(parentId: string): string[]
}

export interface PmProjectResolver {
  ensureProject(projectId: string): void | Promise<void>
}

export interface PmClock {
  now(): string
}

export interface PmIdGenerator {
  nextTicketId(): string
}

export interface PmTransactionRunner {
  run<T>(fn: () => T): T
}
