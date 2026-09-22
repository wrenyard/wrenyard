import { PmError } from '../errors.mts'
import type { PmTicketStatus, PmTicketKind } from './model.mts'

const statusTransitions: Record<PmTicketStatus, PmTicketStatus[]> = {
  todo: ['in_progress', 'blocked'],
  in_progress: ['done', 'blocked', 'todo'],
  blocked: ['todo', 'in_progress'],
  done: ['in_progress', 'blocked'],
}

export function assertValidStatusTransition(from: PmTicketStatus, to: PmTicketStatus): void {
  const allowed = statusTransitions[from]
  if (!allowed?.includes(to)) {
    throw new PmError(
      'invalid_status_transition',
      `Cannot transition status from '${from}' to '${to}'`,
    )
  }
}

export function assertTitleNonEmpty(title: string): void {
  if (!title || !title.trim()) {
    throw new PmError('invalid_patch', 'Title must be non-empty')
  }
}

export function assertValidCreateShape(
  kind: PmTicketKind,
  parentId: string | undefined,
  assignee: unknown,
): void {
  if (kind === 'main') {
    if (parentId !== undefined && parentId !== null) {
      throw new PmError('invalid_field_for_kind', 'Main tickets cannot have a parent_id')
    }
    // assignee is allowed for main
  } else {
    // sub
    if (!parentId) {
      throw new PmError('invalid_field_for_kind', 'Sub-tickets require a parent_id')
    }
    if (assignee !== undefined && assignee !== null) {
      throw new PmError('invalid_field_for_kind', 'Sub-tickets cannot have an assignee')
    }
  }
}

export function assertValidEditFields(
  title: unknown,
  description: unknown,
  assignee: unknown,
): void {
  const hasTitle = title !== undefined
  const hasDescription = description !== undefined
  const hasAssignee = assignee !== undefined

  if (!hasTitle && !hasDescription && !hasAssignee) {
    throw new PmError('invalid_patch', 'Edit patch must contain at least one field to update')
  }

  if (hasTitle && typeof title === 'string' && !title.trim()) {
    throw new PmError('invalid_patch', 'Title must be non-empty when provided')
  }
}

export function assertAssigneeOnlyForMain(kind: PmTicketKind): void {
  if (kind !== 'main' && kind !== undefined) {
    // assignee is only valid for main tickets
  }
}

export function assertParentIsMain(parentTicketKind: PmTicketKind): void {
  if (parentTicketKind !== 'main') {
    throw new PmError('parent_must_be_main', 'Parent ticket must be a main ticket')
  }
}
