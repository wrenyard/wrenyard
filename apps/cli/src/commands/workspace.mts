import { parseArgs } from 'node:util'
import { readFileSync } from 'node:fs'
import { requireNoPositionals, requireSinglePositional } from '../helpers.mts'
import {
  connectConfiguredForemanClient,
  isHelpRequest,
  servicePayload,
  writeServicePayload,
} from '../shared.mts'

/** The document kinds accepted by the workspace doc subcommands. */
type WorkspaceDocKind = 'spec' | 'report' | 'handoff'

export async function handleWorkspace(args: string[]): Promise<number> {
  const subcommand = args[0]
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log('Usage: wrenyard workspace <status|diff|commit|push|pull|doc> ...')
    return subcommand ? 0 : 1
  }

  if (subcommand === 'status') return handleWorkspaceStatus(args.slice(1))
  if (subcommand === 'diff') return handleWorkspaceDiff(args.slice(1))
  if (subcommand === 'commit') return handleWorkspaceCommit(args.slice(1))
  if (subcommand === 'push') return handleWorkspacePush(args.slice(1))
  if (subcommand === 'pull') return handleWorkspacePull(args.slice(1))
  if (subcommand === 'doc') return handleWorkspaceDoc(args.slice(1))

  console.error('Usage: wrenyard workspace <status|diff|commit|push|pull|doc> ...')
  return 1
}

export async function handleWorkspaceStatus(args: string[]): Promise<number> {
  const usage = 'Usage: wrenyard workspace status [--config path] [--json]'
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
    writeServicePayload(servicePayload(await client.workspaceVcs.status()))
    return 0
  } finally {
    client.close()
  }
}

export async function handleWorkspaceDiff(args: string[]): Promise<number> {
  const usage = 'Usage: wrenyard workspace diff [--staged] [--path <p>]... [--config path] [--json]'
  if (isHelpRequest(args)) {
    console.log(usage)
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      json: { type: 'boolean' },
      staged: { type: 'boolean' },
      path: { type: 'string', multiple: true },
    },
    allowPositionals: true,
    strict: true,
  })
  requireNoPositionals(positionals, usage)

  const client = await connectConfiguredForemanClient(values.config)
  try {
    const result = await client.workspaceVcs.diff({
      ...(values.staged === undefined ? {} : { staged: values.staged }),
      ...(values.path === undefined ? {} : { paths: values.path }),
    })
    writeServicePayload(servicePayload(result))
    return 0
  } finally {
    client.close()
  }
}

export async function handleWorkspaceCommit(args: string[]): Promise<number> {
  const usage = 'Usage: wrenyard workspace commit -m <message> <file>... [--config path] [--json]'
  if (isHelpRequest(args)) {
    console.log(usage)
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      json: { type: 'boolean' },
      message: { type: 'string', short: 'm' },
    },
    allowPositionals: true,
    strict: true,
  })
  if (!values.message || positionals.length === 0) {
    console.error(usage)
    return 1
  }

  const client = await connectConfiguredForemanClient(values.config)
  try {
    const result = await client.workspaceVcs.commit({ message: values.message, files: positionals })
    writeServicePayload(servicePayload(result))
    return result.hash ? 0 : 1
  } finally {
    client.close()
  }
}

export async function handleWorkspacePush(args: string[]): Promise<number> {
  const usage = 'Usage: wrenyard workspace push [--config path] [--json]'
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
    const result = await client.workspaceVcs.push()
    writeServicePayload(servicePayload(result))
    return result.pushed ? 0 : 1
  } finally {
    client.close()
  }
}

export async function handleWorkspacePull(args: string[]): Promise<number> {
  const usage = 'Usage: wrenyard workspace pull [--config path] [--json]'
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
    const result = await client.workspaceVcs.pull()
    writeServicePayload(servicePayload(result))
    return result.pulled ? 0 : 1
  } finally {
    client.close()
  }
}

export async function handleWorkspaceDoc(args: string[]): Promise<number> {
  const subcommand = args[0]
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log('Usage: wrenyard workspace doc <list|read|create|update|edit|delete> ...')
    return subcommand ? 0 : 1
  }

  if (subcommand === 'list') return handleWorkspaceDocList(args.slice(1))
  if (subcommand === 'read') return handleWorkspaceDocRead(args.slice(1))
  if (subcommand === 'create') return handleWorkspaceDocCreate(args.slice(1))
  if (subcommand === 'update') return handleWorkspaceDocUpdate(args.slice(1))
  if (subcommand === 'edit') return handleWorkspaceDocEdit(args.slice(1))
  if (subcommand === 'delete') return handleWorkspaceDocDelete(args.slice(1))

  console.error('Usage: wrenyard workspace doc <list|read|create|update|edit|delete> ...')
  return 1
}

export async function handleWorkspaceDocList(args: string[]): Promise<number> {
  const usage = 'Usage: wrenyard workspace doc list <project> [--kind <kind>] [--config path] [--json]'
  if (isHelpRequest(args)) {
    console.log(usage)
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' }, json: { type: 'boolean' }, kind: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  })
  const project = requireSinglePositional(positionals, usage)

  const client = await connectConfiguredForemanClient(values.config)
  try {
    const result = await client.workspaceDoc.list(
      values.kind === undefined ? { project } : { project, kind: values.kind as WorkspaceDocKind },
    )
    writeServicePayload(servicePayload(result))
    return 0
  } finally {
    client.close()
  }
}

export async function handleWorkspaceDocRead(args: string[]): Promise<number> {
  const usage = 'Usage: wrenyard workspace doc read <project> <kind> <name> [--config path] [--json]'
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
  if (positionals.length !== 3) {
    console.error(usage)
    return 1
  }
  const [project, kind, name] = positionals

  const client = await connectConfiguredForemanClient(values.config)
  try {
    const result = await client.workspaceDoc.read({ project, kind: kind as WorkspaceDocKind, name })
    writeServicePayload(servicePayload(result))
    return 0
  } finally {
    client.close()
  }
}

export async function handleWorkspaceDocCreate(args: string[]): Promise<number> {
  const usage = 'Usage: wrenyard workspace doc create <project> <kind> <slug> --file <f> [--config path] [--json]'
  if (isHelpRequest(args)) {
    console.log(usage)
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' }, json: { type: 'boolean' }, file: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length !== 3 || !values.file) {
    console.error(usage)
    return 1
  }
  const [project, kind, name] = positionals
  const content = readFileSync(values.file, 'utf-8')

  const client = await connectConfiguredForemanClient(values.config)
  try {
    const result = await client.workspaceDoc.create({ project, kind: kind as WorkspaceDocKind, name, content })
    writeServicePayload(servicePayload(result))
    return 0
  } finally {
    client.close()
  }
}

export async function handleWorkspaceDocUpdate(args: string[]): Promise<number> {
  const usage = 'Usage: wrenyard workspace doc update <project> <kind> <name> --file <f> --base <version> [--config path] [--json]'
  if (isHelpRequest(args)) {
    console.log(usage)
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      json: { type: 'boolean' },
      file: { type: 'string' },
      base: { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length !== 3 || !values.file || !values.base) {
    console.error(usage)
    return 1
  }
  const [project, kind, name] = positionals
  const content = readFileSync(values.file, 'utf-8')

  const client = await connectConfiguredForemanClient(values.config)
  try {
    const result = await client.workspaceDoc.update({
      project,
      kind: kind as WorkspaceDocKind,
      name,
      content,
      base_version: values.base,
    })
    writeServicePayload(servicePayload(result))
    return 0
  } finally {
    client.close()
  }
}

export async function handleWorkspaceDocEdit(args: string[]): Promise<number> {
  const usage = 'Usage: wrenyard workspace doc edit <project> <kind> <name> --old <text> --new <text> [--base <version>] [--config path] [--json]'
  if (isHelpRequest(args)) {
    console.log(usage)
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      json: { type: 'boolean' },
      old: { type: 'string' },
      new: { type: 'string' },
      base: { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length !== 3 || values.old === undefined || values.new === undefined) {
    console.error(usage)
    return 1
  }
  const [project, kind, name] = positionals

  const client = await connectConfiguredForemanClient(values.config)
  try {
    const result = await client.workspaceDoc.edit({
      project,
      kind: kind as WorkspaceDocKind,
      name,
      edits: [{ old: values.old, new: values.new }],
      ...(values.base === undefined ? {} : { base_version: values.base }),
    })
    writeServicePayload(servicePayload(result))
    return 0
  } finally {
    client.close()
  }
}

export async function handleWorkspaceDocDelete(args: string[]): Promise<number> {
  const usage = 'Usage: wrenyard workspace doc delete <project> <kind> <name> --base <version> [--config path] [--json]'
  if (isHelpRequest(args)) {
    console.log(usage)
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      json: { type: 'boolean' },
      base: { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length !== 3 || !values.base) {
    console.error(usage)
    return 1
  }
  const [project, kind, name] = positionals

  const client = await connectConfiguredForemanClient(values.config)
  try {
    const result = await client.workspaceDoc.delete({
      project,
      kind: kind as WorkspaceDocKind,
      name,
      base_version: values.base,
    })
    writeServicePayload(servicePayload(result))
    return 0
  } finally {
    client.close()
  }
}
