import { parseArgs } from 'node:util'
import type {
  PmTicketCreateParams,
  PmTicketKind,
  PmTicketListParams,
  PmTicketStatus,
  PmTicketUpdateParams,
} from '../../../protocol/methods/pm.mts'
import { requireNoPositionals, requireSinglePositional } from '../helpers.mts'
import {
  connectConfiguredForemanClient,
  isHelpRequest,
  servicePayload,
  writeServicePayload,
} from '../shared.mts'

const ticketKinds = ['main', 'sub'] as const
const ticketStatuses = ['todo', 'in_progress', 'done', 'blocked'] as const

export async function handlePm(args: string[]): Promise<number> {
  const subcommand = args[0]
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.error('Usage: wrenyard pm ticket <create|get|list|update|status|delete> ...')
    return subcommand ? 0 : 1
  }
  if (subcommand === 'ticket') return handlePmTicket(args.slice(1))
  console.error('Usage: wrenyard pm ticket <create|get|list|update|status|delete> ...')
  return 1
}

async function handlePmTicket(args: string[]): Promise<number> {
  const subcommand = args[0]
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.error('Usage: wrenyard pm ticket <create|get|list|update|status|delete> ...')
    return subcommand ? 0 : 1
  }
  if (subcommand === 'create') return handlePmTicketCreate(args.slice(1))
  if (subcommand === 'get') return handlePmTicketGet(args.slice(1))
  if (subcommand === 'list') return handlePmTicketList(args.slice(1))
  if (subcommand === 'update') return handlePmTicketUpdate(args.slice(1))
  if (subcommand === 'status') return handlePmTicketStatus(args.slice(1))
  if (subcommand === 'delete') return handlePmTicketDelete(args.slice(1))
  console.error('Usage: wrenyard pm ticket <create|get|list|update|status|delete> ...')
  return 1
}

export async function handlePmTicketCreate(args: string[]): Promise<number> {
  const usage = 'wrenyard pm ticket create --kind <main|sub> -p <project> --title <title> [--description text] [--parent id] [--assignee session] [--config path]'
  if (isHelpRequest(args)) {
    console.log(`Usage: ${usage}`)
    return 0
  }

  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      project: { type: 'string', short: 'p' },
      kind: { type: 'string' },
      title: { type: 'string' },
      description: { type: 'string' },
      parent: { type: 'string' },
      assignee: { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  })
  requireNoPositionals(positionals, usage)

  const kind = parseTicketKind(values.kind, '--kind')
  const projectId = requireOptionString(values.project, '-p <project>')
  const title = requireOptionString(values.title, '--title')
  const description = optionalString(values.description)
  const parentId = optionalString(values.parent)
  const assigneeSessionId = optionalString(values.assignee)

  if (kind === 'main' && parentId) throw new Error('--parent is only valid for sub tickets')
  if (kind === 'sub' && assigneeSessionId) throw new Error('--assignee is only valid for main tickets')
  if (kind === 'sub' && !parentId) throw new Error('--parent is required for sub tickets')

  const params: PmTicketCreateParams = kind === 'main'
    ? {
        kind,
        project_id: projectId,
        title,
        ...(description !== undefined ? { description } : {}),
        ...(assigneeSessionId ? { assignee: { session_id: assigneeSessionId } } : {}),
      }
    : {
        kind,
        project_id: projectId,
        title,
        parent_id: parentId!,
        ...(description !== undefined ? { description } : {}),
      }

  const client = await connectConfiguredForemanClient(values.config)
  try {
    writeServicePayload(servicePayload(await client.pm.ticket.create(params)))
    return 0
  } finally {
    client.close()
  }
}

export async function handlePmTicketGet(args: string[]): Promise<number> {
  const usage = 'wrenyard pm ticket get <ticket_id> [--config path]'
  if (isHelpRequest(args)) {
    console.log(`Usage: ${usage}`)
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  })
  const id = requireSinglePositional(positionals, usage)

  const client = await connectConfiguredForemanClient(values.config)
  try {
    writeServicePayload(servicePayload(await client.pm.ticket.get({ id })))
    return 0
  } finally {
    client.close()
  }
}

export async function handlePmTicketList(args: string[]): Promise<number> {
  const usage = 'wrenyard pm ticket list -p <project> [--kind main|sub] [--status todo|in_progress|done|blocked] [--parent id] [--assignee session] [--config path]'
  if (isHelpRequest(args)) {
    console.log(`Usage: ${usage}`)
    return 0
  }

  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      project: { type: 'string', short: 'p' },
      kind: { type: 'string' },
      status: { type: 'string' },
      parent: { type: 'string' },
      assignee: { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  })
  requireNoPositionals(positionals, usage)

  const params: PmTicketListParams = {
    project_id: requireOptionString(values.project, '-p <project>'),
    ...(values.kind !== undefined ? { kind: parseTicketKind(values.kind, '--kind') } : {}),
    ...(values.status !== undefined ? { status: parseTicketStatus(values.status, '--status') } : {}),
    ...(optionalString(values.parent) ? { parent_id: optionalString(values.parent) } : {}),
    ...(optionalString(values.assignee) ? { assignee_session_id: optionalString(values.assignee) } : {}),
  }

  const client = await connectConfiguredForemanClient(values.config)
  try {
    writeServicePayload(servicePayload(await client.pm.ticket.list(params)))
    return 0
  } finally {
    client.close()
  }
}

export async function handlePmTicketUpdate(args: string[]): Promise<number> {
  const usage = 'wrenyard pm ticket update <ticket_id> [--title text] [--description text|--clear-description] [--assignee session|--clear-assignee] [--config path]'
  if (isHelpRequest(args)) {
    console.log(`Usage: ${usage}`)
    return 0
  }

  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      title: { type: 'string' },
      description: { type: 'string' },
      'clear-description': { type: 'boolean' },
      assignee: { type: 'string' },
      'clear-assignee': { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  })
  const id = requireSinglePositional(positionals, usage)

  if (values.description !== undefined && values['clear-description']) {
    throw new Error('--description and --clear-description cannot be used together')
  }
  if (values.assignee !== undefined && values['clear-assignee']) {
    throw new Error('--assignee and --clear-assignee cannot be used together')
  }

  const params: PmTicketUpdateParams = {
    action: 'edit',
    id,
    ...(values.title !== undefined ? { title: requireOptionString(values.title, '--title') } : {}),
    ...(values.description !== undefined ? { description: values.description } : {}),
    ...(values['clear-description'] ? { description: null } : {}),
    ...(values.assignee !== undefined ? { assignee: { session_id: requireOptionString(values.assignee, '--assignee') } } : {}),
    ...(values['clear-assignee'] ? { assignee: null } : {}),
  }

  if (!('title' in params) && !('description' in params) && !('assignee' in params)) {
    console.error(`Usage: ${usage}`)
    return 1
  }

  const client = await connectConfiguredForemanClient(values.config)
  try {
    writeServicePayload(servicePayload(await client.pm.ticket.update(params)))
    return 0
  } finally {
    client.close()
  }
}

export async function handlePmTicketStatus(args: string[]): Promise<number> {
  const usage = 'wrenyard pm ticket status <ticket_id> <todo|in_progress|done|blocked> [--config path]'
  if (isHelpRequest(args)) {
    console.log(`Usage: ${usage}`)
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length !== 2) {
    console.error(`Usage: ${usage}`)
    return 1
  }

  const client = await connectConfiguredForemanClient(values.config)
  try {
    writeServicePayload(servicePayload(await client.pm.ticket.update({
      id: positionals[0],
      action: 'set_status',
      status: parseTicketStatus(positionals[1], '<status>'),
    })))
    return 0
  } finally {
    client.close()
  }
}

export async function handlePmTicketDelete(args: string[]): Promise<number> {
  const usage = 'wrenyard pm ticket delete <ticket_id> [--config path]'
  if (isHelpRequest(args)) {
    console.log(`Usage: ${usage}`)
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  })
  const id = requireSinglePositional(positionals, usage)

  const client = await connectConfiguredForemanClient(values.config)
  try {
    writeServicePayload(servicePayload(await client.pm.ticket.delete({ id })))
    return 0
  } finally {
    client.close()
  }
}

function parseTicketKind(value: unknown, name: string): PmTicketKind {
  if (typeof value === 'string' && ticketKinds.includes(value as PmTicketKind)) return value as PmTicketKind
  throw new Error(`${name} must be one of: ${ticketKinds.join(', ')}`)
}

function parseTicketStatus(value: unknown, name: string): PmTicketStatus {
  if (typeof value === 'string' && ticketStatuses.includes(value as PmTicketStatus)) return value as PmTicketStatus
  throw new Error(`${name} must be one of: ${ticketStatuses.join(', ')}`)
}

function requireOptionString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`)
  return value.trim()
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}
