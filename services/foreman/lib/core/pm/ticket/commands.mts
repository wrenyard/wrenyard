import { PmError } from '../errors.mts'
import type {
  PmTicket,
  PmTicketStatus,
  PmTicketKind,
  PmTicketCreateInput,
  PmTicketGetInput,
  PmTicketListInput,
  PmTicketUpdateInput,
  PmTicketDeleteInput,
  PmTicketUpdateEditInput,
  PmTicketUpdateSetStatusInput,
} from './model.mts'
import {
  assertValidStatusTransition,
  assertTitleNonEmpty,
  assertValidCreateShape,
  assertValidEditFields,
  assertParentIsMain,
} from './rules.mts'
import type {
  PmTicketRepository,
  PmProjectResolver,
  PmClock,
  PmIdGenerator,
  PmTransactionRunner,
  PmTicketFilter,
} from '../ports.mts'

export interface PmTicketCommands {
  create(input: PmTicketCreateInput): Promise<PmTicket>
  get(input: PmTicketGetInput): Promise<PmTicket>
  list(input: PmTicketListInput): Promise<PmTicket[]>
  update(input: PmTicketUpdateInput): Promise<PmTicket>
  delete(input: PmTicketDeleteInput): Promise<{ deleted: true; id: string }>
}

export interface PmTicketCommandsDeps {
  tickets: PmTicketRepository
  projects: PmProjectResolver
  clock: PmClock
  ids: PmIdGenerator
  transactions: PmTransactionRunner
}

export function createPmTicketCommands(deps: PmTicketCommandsDeps): PmTicketCommands {
  const { tickets, projects, clock, ids, transactions } = deps

  async function create(input: PmTicketCreateInput): Promise<PmTicket> {
    await projects.ensureProject(input.project_id)
    assertTitleNonEmpty(input.title)
    assertValidCreateShape(input.kind, input.parent_id, input.assignee)

    const now = clock.now()

    if (input.kind === 'main') {
      return transactions.run(() => {
        const ticket: PmTicket = {
          id: ids.nextTicketId(),
          kind: 'main',
          project_id: input.project_id,
          title: input.title.trim(),
          description: input.description,
          status: 'todo',
          assignee: input.assignee,
          created_at: now,
          updated_at: now,
        }
        tickets.insert(ticket)
        return ticket
      })
    }

    // sub
    const parentTicket = tickets.get(input.parent_id!)
    if (!parentTicket) {
      throw new PmError('parent_ticket_not_found', `Parent ticket '${input.parent_id}' not found`)
    }
    assertParentIsMain(parentTicket.kind)
    if (parentTicket.project_id !== input.project_id) {
      throw new PmError('project_mismatch', 'Parent ticket belongs to a different project')
    }

    return transactions.run(() => {
      const ticket: PmTicket = {
        id: ids.nextTicketId(),
        kind: 'sub',
        project_id: input.project_id,
        title: input.title.trim(),
        description: input.description,
        status: 'todo',
        parent_id: input.parent_id,
        created_at: now,
        updated_at: now,
      }
      tickets.insert(ticket)
      return ticket
    })
  }

  async function get(input: PmTicketGetInput): Promise<PmTicket> {
    const ticket = tickets.get(input.id)
    if (!ticket) {
      throw new PmError('ticket_not_found', `Ticket '${input.id}' not found`)
    }
    return ticket
  }

  async function list(input: PmTicketListInput): Promise<PmTicket[]> {
    await projects.ensureProject(input.project_id)
    const filter: PmTicketFilter = {
      project_id: input.project_id,
      kind: input.kind,
      status: input.status,
      parent_id: input.parent_id,
      assignee_session_id: input.assignee_session_id,
    }
    return tickets.list(filter)
  }

  async function update(input: PmTicketUpdateInput): Promise<PmTicket> {
    const existing = tickets.get(input.id)
    if (!existing) {
      throw new PmError('ticket_not_found', `Ticket '${input.id}' not found`)
    }

    if (input.action === 'edit') {
      return handleEdit(existing, input)
    }

    return handleSetStatus(existing, input)
  }

  function handleEdit(existing: PmTicket, input: PmTicketUpdateEditInput): PmTicket {
    assertValidEditFields(input.title, input.description, input.assignee)

    const patch: Partial<PmTicket> = {}

    if (input.title !== undefined) {
      if (!input.title.trim()) {
        throw new PmError('invalid_patch', 'Title must be non-empty')
      }
      patch.title = input.title.trim()
    }

    if (input.description !== undefined) {
      patch.description = input.description ?? undefined
    }

    if (input.assignee !== undefined) {
      if (existing.kind !== 'main') {
        throw new PmError('invalid_field_for_kind', 'Only main tickets can have an assignee')
      }
      patch.assignee = input.assignee ?? undefined
    }

    return transactions.run(() => {
      const updated: PmTicket = {
        ...existing,
        ...patch,
        updated_at: clock.now(),
      }
      tickets.update(updated)
      return updated
    })
  }

  function handleSetStatus(existing: PmTicket, input: PmTicketUpdateSetStatusInput): PmTicket {
    assertValidStatusTransition(existing.status, input.status)

    if (existing.kind === 'main' && input.status === 'done') {
      const openSubIds = tickets.listOpenSubticketIds(existing.id)
      if (openSubIds.length > 0) {
        throw new PmError(
          'main_has_open_subtickets',
          `Cannot mark main ticket as done: ${openSubIds.length} open sub-ticket(s)`,
        )
      }
    }

    return transactions.run(() => {
      const updated: PmTicket = {
        ...existing,
        status: input.status,
        updated_at: clock.now(),
      }
      tickets.update(updated)
      return updated
    })
  }

  async function deleteTicket(input: PmTicketDeleteInput): Promise<{ deleted: true; id: string }> {
    const existing = tickets.get(input.id)
    if (!existing) {
      throw new PmError('ticket_not_found', `Ticket '${input.id}' not found`)
    }

    if (existing.kind === 'main') {
      const childCount = tickets.countChildren(existing.id)
      if (childCount > 0) {
        throw new PmError(
          'main_has_subtickets',
          `Cannot delete main ticket: ${childCount} sub-ticket(s) exist`,
        )
      }
    }

    return transactions.run(() => {
      tickets.delete(input.id)
      return { deleted: true as const, id: input.id }
    })
  }

  return { create, get, list, update, delete: deleteTicket }
}
