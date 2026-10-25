import { parseArgs } from 'node:util'
import { requireNoPositionals, requireSinglePositional } from '../helpers.mts'
import {
  connectConfiguredForemanClient,
  isHelpRequest,
  servicePayload,
  writeServicePayload,
} from '../shared.mts'

/** The exact statuses `todo set-status` accepts, shared with the daemon store. */
const TODO_STATUSES = ['open', 'in_progress', 'done', 'cancelled'] as const

type TodoStatus = (typeof TODO_STATUSES)[number]

export async function handleTodo(args: string[]): Promise<number> {
  const subcommand = args[0]
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log('Usage: wrenyard todo <list|add|show|set-status|update|comment|uncomment|tag|untag> ...')
    return subcommand ? 0 : 1
  }

  if (subcommand === 'list') return handleTodoList(args.slice(1))
  if (subcommand === 'add') return handleTodoAdd(args.slice(1))
  if (subcommand === 'show') return handleTodoShow(args.slice(1))
  if (subcommand === 'set-status') return handleTodoSetStatus(args.slice(1))
  if (subcommand === 'update') return handleTodoUpdate(args.slice(1))
  if (subcommand === 'comment') return handleTodoComment(args.slice(1))
  if (subcommand === 'uncomment') return handleTodoUncomment(args.slice(1))
  if (subcommand === 'tag') return handleTodoTag(args.slice(1))
  if (subcommand === 'untag') return handleTodoUntag(args.slice(1))

  console.error('Usage: wrenyard todo <list|add|show|set-status|update|comment|uncomment|tag|untag> ...')
  return 1
}

export async function handleTodoList(args: string[]): Promise<number> {
  const usage = 'Usage: wrenyard todo list [--tag <tag>] [--config path] [--json]'
  if (isHelpRequest(args)) {
    console.log(usage)
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' }, json: { type: 'boolean' }, tag: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  })
  requireNoPositionals(positionals, usage)

  const client = await connectConfiguredForemanClient(values.config)
  try {
    const result = await client.todo.list(values.tag === undefined ? {} : { tag: values.tag })
    writeServicePayload(servicePayload(result))
    return 0
  } finally {
    client.close()
  }
}

export async function handleTodoUpdate(args: string[]): Promise<number> {
  const usage = 'Usage: wrenyard todo update <id> [--old-title <text> --title <text>] [--old-request <text> --request <text>] [--old-acceptance <text> --acceptance <text>] [--status <status>] [--project <p>] [--depends-on <id>]... [--attach <path>]... [--config path] [--json]'
  if (isHelpRequest(args)) { console.log(usage); return 0 }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' }, json: { type: 'boolean' }, title: { type: 'string' }, 'old-title': { type: 'string' }, request: { type: 'string' }, 'old-request': { type: 'string' }, acceptance: { type: 'string' }, 'old-acceptance': { type: 'string' }, status: { type: 'string' }, project: { type: 'string' }, 'depends-on': { type: 'string', multiple: true }, attach: { type: 'string', multiple: true } },
    allowPositionals: true, strict: true,
  })
  if (positionals.length !== 1) { console.error(usage); return 1 }
  for (const [field, old] of [['title', 'old-title'], ['request', 'old-request'], ['acceptance', 'old-acceptance']] as const) {
    if ((values[field] === undefined) !== (values[old] === undefined)) { console.error(`${usage}\n--${field} and --${old} must be supplied together.`); return 1 }
  }
  if (values.status !== undefined && !(TODO_STATUSES as readonly string[]).includes(values.status)) { console.error(usage); return 1 }
  const [id] = positionals
  const client = await connectConfiguredForemanClient(values.config)
  try {
    const result = await client.todo.update({ id,
      ...(values.title === undefined || values['old-title'] === undefined ? {} : { title: values.title, old_title: values['old-title'] }),
      ...(values.request === undefined || values['old-request'] === undefined ? {} : { request: values.request, old_request: values['old-request'] }),
      ...(values.acceptance === undefined || values['old-acceptance'] === undefined ? {} : { acceptance: values.acceptance, old_acceptance: values['old-acceptance'] }),
      ...(values.status === undefined ? {} : { status: values.status as TodoStatus }),
      ...(values.project === undefined ? {} : { project: values.project }),
      ...(values['depends-on'] === undefined ? {} : { depends_on: values['depends-on'] }),
      ...(values.attach === undefined ? {} : { attachments: values.attach }),
    })
    writeServicePayload(servicePayload(result)); return 0
  } finally { client.close() }
}

export async function handleTodoComment(args: string[]): Promise<number> {
  const usage = 'Usage: wrenyard todo comment <id> --text <text> [--config path] [--json]'
  return withTodoMutation(args, usage, async (client, id, values) => client.todo.comment({ id, text: values.text! }))
}

export async function handleTodoUncomment(args: string[]): Promise<number> {
  const usage = 'Usage: wrenyard todo uncomment <id> --comment-id <6-hex-id> [--config path] [--json]'
  return withTodoMutation(args, usage, async (client, id, values) => client.todo.uncomment({ id, commentId: values['comment-id']! }), ['comment-id'])
}

export async function handleTodoTag(args: string[]): Promise<number> {
  const usage = 'Usage: wrenyard todo tag <id> --tag <tag>... [--config path] [--json]'
  return withTodoMutation(args, usage, async (client, id, values) => client.todo.tag({ id, tags: Array.isArray(values.tag) ? values.tag : [values.tag!] }), ['tag'], true)
}

export async function handleTodoUntag(args: string[]): Promise<number> {
  const usage = 'Usage: wrenyard todo untag <id> --tag <tag> [--config path] [--json]'
  return withTodoMutation(args, usage, async (client, id, values) => {
    const tag = values.tag
    if (typeof tag !== 'string') throw new Error('--tag must be a single string')
    return client.todo.untag({ id, tag })
  }, ['tag'])
}

type TodoMutationValues = {
  text?: string
  'comment-id'?: string
  tag?: string | string[]
}

type TodoMutationRequired = 'text' | 'comment-id' | 'tag'

async function withTodoMutation(args: string[], usage: string, call: (client: Awaited<ReturnType<typeof connectConfiguredForemanClient>>, id: string, values: TodoMutationValues) => Promise<unknown>, required: TodoMutationRequired[] = ['text'], multiple = false): Promise<number> {
  if (isHelpRequest(args)) { console.log(usage); return 0 }
  const { values, positionals } = parseArgs({ args, options: { config: { type: 'string' }, json: { type: 'boolean' }, text: { type: 'string' }, 'comment-id': { type: 'string' }, tag: { type: 'string', multiple } }, allowPositionals: true, strict: true })
  const mutationValues: TodoMutationValues = { text: values.text, 'comment-id': values['comment-id'], tag: values.tag }
  if (positionals.length !== 1 || required.some((key) => mutationValues[key] === undefined) || (!multiple && Array.isArray(mutationValues.tag) && mutationValues.tag.length !== 1)) { console.error(usage); return 1 }
  const client = await connectConfiguredForemanClient(values.config)
  try { const result = await call(client, positionals[0], mutationValues); writeServicePayload(servicePayload(result)); return 0 }
  finally { client.close() }
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
