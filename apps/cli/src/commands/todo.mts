import { parseArgs } from 'node:util'
import { requireNoPositionals, requireSinglePositional } from '../helpers.mts'
import {
  connectConfiguredForemanClient,
  isHelpRequest,
  servicePayload,
  writeServicePayload,
} from '../shared.mts'

/** The exact statuses `todo set-status` accepts, shared with the daemon store. */
const TODO_STATUSES = ['open', 'in_progress', 'done', 'accepted', 'cancelled'] as const

type TodoStatus = (typeof TODO_STATUSES)[number]

export async function handleTodo(args: string[]): Promise<number> {
  const subcommand = args[0]
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log('Usage: wrenyard todo <list|add|show|set-status> ...')
    return subcommand ? 0 : 1
  }

  if (subcommand === 'list') return handleTodoList(args.slice(1))
  if (subcommand === 'add') return handleTodoAdd(args.slice(1))
  if (subcommand === 'show') return handleTodoShow(args.slice(1))
  if (subcommand === 'set-status') return handleTodoSetStatus(args.slice(1))

  console.error('Usage: wrenyard todo <list|add|show|set-status> ...')
  return 1
}

export async function handleTodoList(args: string[]): Promise<number> {
  const usage = 'Usage: wrenyard todo list [--config path] [--json]'
  if (isHelpRequest(args)) {
    console.log(usage)
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' }, json: { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  })
  requireNoPositionals(positionals, usage)

  const client = await connectConfiguredForemanClient(values.config)
  try {
    const result = await client.todo.list()
    writeServicePayload(servicePayload(result))
    return 0
  } finally {
    client.close()
  }
}

export async function handleTodoAdd(args: string[]): Promise<number> {
  const usage =
    'Usage: wrenyard todo add --title <t> [--request <text>] [--acceptance <text>] [--project <p>] [--depends-on <id>]... [--attach <path>]... [--config path] [--json]'
  if (isHelpRequest(args)) {
    console.log(usage)
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      json: { type: 'boolean' },
      title: { type: 'string' },
      request: { type: 'string' },
      acceptance: { type: 'string' },
      project: { type: 'string' },
      'depends-on': { type: 'string', multiple: true },
      attach: { type: 'string', multiple: true },
    },
    allowPositionals: true,
    strict: true,
  })
  requireNoPositionals(positionals, usage)
  if (!values.title) {
    console.error(usage)
    return 1
  }

  const client = await connectConfiguredForemanClient(values.config)
  try {
    const result = await client.todo.create({
      title: values.title,
      ...(values.request === undefined ? {} : { request: values.request }),
      ...(values.acceptance === undefined ? {} : { acceptance: values.acceptance }),
      ...(values.project === undefined ? {} : { project: values.project }),
      ...(values['depends-on'] === undefined ? {} : { depends_on: values['depends-on'] }),
      ...(values.attach === undefined ? {} : { attachments: values.attach }),
    })
    writeServicePayload(servicePayload(result))
    return 0
  } finally {
    client.close()
  }
}

export async function handleTodoShow(args: string[]): Promise<number> {
  const usage = 'Usage: wrenyard todo show <id> [--config path] [--json]'
  if (isHelpRequest(args)) {
    console.log(usage)
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' }, json: { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  })
  const id = requireSinglePositional(positionals, usage)

  const client = await connectConfiguredForemanClient(values.config)
  try {
    const result = await client.todo.get({ id })
    writeServicePayload(servicePayload(result))
    return 0
  } finally {
    client.close()
  }
}

export async function handleTodoSetStatus(args: string[]): Promise<number> {
  const usage = `Usage: wrenyard todo set-status <id> <${TODO_STATUSES.join('|')}> [--config path] [--json]`
  if (isHelpRequest(args)) {
    console.log(usage)
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' }, json: { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length !== 2) {
    console.error(usage)
    return 1
  }
  const [id, status] = positionals
  if (!(TODO_STATUSES as readonly string[]).includes(status)) {
    console.error(usage)
    return 1
  }

  const client = await connectConfiguredForemanClient(values.config)
  try {
    const result = await client.todo.update({ id, status: status as TodoStatus })
    writeServicePayload(servicePayload(result))
    return 0
  } finally {
    client.close()
  }
}
