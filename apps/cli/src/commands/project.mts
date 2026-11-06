
import { parseArgs } from 'node:util'
import { requireNoPositionals, requireSinglePositional } from '../helpers.mts'
import {
  connectConfiguredForemanClient,
  isHelpRequest,
  servicePayload,
  writeServicePayload,
} from '../shared.mts'

export async function handleProject(args: string[]): Promise<number> {
  const subcommand = args[0]
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log('Usage: wrenyard project <list|describe|status|pull|push|diff|commit|register|worktree> ...')
    return subcommand ? 0 : 1
  }

  if (subcommand === 'list') return handleProjectList(args.slice(1))
  if (subcommand === 'describe') return handleProjectDescribe(args.slice(1))
  if (subcommand === 'status') return handleProjectStatus(args.slice(1))
  if (subcommand === 'pull') return handleProjectPull(args.slice(1))
  if (subcommand === 'push') return handleProjectPush(args.slice(1))
  if (subcommand === 'diff') return handleProjectDiff(args.slice(1))
  if (subcommand === 'commit') return handleProjectCommit(args.slice(1))
  if (subcommand === 'register') return handleProjectRegister(args.slice(1))
  if (subcommand === 'worktree') return handleProjectWorktree(args.slice(1))

  console.error('Usage: wrenyard project <list|describe|status|pull|push|diff|commit|register|worktree> ...')
  return 1
}

export async function handleProjectList(args: string[]): Promise<number> {
  if (isHelpRequest(args)) {
    console.log('Usage: wrenyard project list [--config path] [--json]')
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' }, json: { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  })
  requireNoPositionals(positionals, 'wrenyard project list [--config path] [--json]')

  const client = await connectConfiguredForemanClient(values.config)
  try {
    writeServicePayload(servicePayload(await client.project.list()))
    return 0
  } finally {
    client.close()
  }
}

export async function handleProjectDescribe(args: string[]): Promise<number> {
  if (isHelpRequest(args)) {
    console.log('Usage: wrenyard project describe <project> [--config path] [--json]')
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' }, json: { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  })
  const project = requireSinglePositional(positionals, 'wrenyard project describe <project> [--config path] [--json]')

  const client = await connectConfiguredForemanClient(values.config)
  try {
    writeServicePayload(servicePayload(await client.project.describe({ project })))
    return 0
  } finally {
    client.close()
  }
}

export async function handleProjectStatus(args: string[]): Promise<number> {
  if (isHelpRequest(args)) {
    console.log('Usage: wrenyard project status <project> [--config path] [--json]')
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' }, json: { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  })
  const project = requireSinglePositional(positionals, 'wrenyard project status <project> [--config path] [--json]')

  const client = await connectConfiguredForemanClient(values.config)
  try {
    writeServicePayload(servicePayload(await client.project.status({ project })))
    return 0
  } finally {
    client.close()
  }
}

export async function handleProjectPull(args: string[]): Promise<number> {
  if (isHelpRequest(args)) {
    console.log('Usage: wrenyard project pull <project> [--config path] [--json]')
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' }, json: { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  })
  const project = requireSinglePositional(positionals, 'wrenyard project pull <project> [--config path] [--json]')

  const client = await connectConfiguredForemanClient(values.config)
  try {
    const result = await client.project.pull({ project })
    writeServicePayload(servicePayload(result))
    return result.pulled ? 0 : 1
  } finally {
    client.close()
  }
}

export async function handleProjectPush(args: string[]): Promise<number> {
  if (isHelpRequest(args)) {
    console.log('Usage: wrenyard project push <project> [--config path] [--json]')
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' }, json: { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  })
  const project = requireSinglePositional(positionals, 'wrenyard project push <project> [--config path] [--json]')

  const client = await connectConfiguredForemanClient(values.config)
  try {
    const result = await client.project.push({ project })
    writeServicePayload(servicePayload(result))
    return result.pushed ? 0 : 1
  } finally {
    client.close()
  }
}

export async function handleProjectDiff(args: string[]): Promise<number> {
  const usage = 'Usage: wrenyard project diff <project> [--worktree <id>] [--staged] [--path <p>]... [--config path] [--json]'
  if (isHelpRequest(args)) {
    console.log(usage)
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      json: { type: 'boolean' },
      worktree: { type: 'string' },
      staged: { type: 'boolean' },
      path: { type: 'string', multiple: true },
    },
    allowPositionals: true,
    strict: true,
  })
  const project = requireSinglePositional(positionals, usage)

  const client = await connectConfiguredForemanClient(values.config)
  try {
    const result = await client.project.diff({
      project,
      ...(values.worktree === undefined ? {} : { worktree_id: values.worktree }),
      ...(values.staged === undefined ? {} : { staged: values.staged }),
      ...(values.path === undefined ? {} : { paths: values.path }),
    })
    writeServicePayload(servicePayload(result))
    return 0
  } finally {
    client.close()
  }
}

export async function handleProjectCommit(args: string[]): Promise<number> {
  const usage = 'Usage: wrenyard project commit <project> [--worktree <id>] -m <message> <file>... [--config path] [--json]'
  if (isHelpRequest(args)) {
    console.log(usage)
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      json: { type: 'boolean' },
      worktree: { type: 'string' },
      message: { type: 'string', short: 'm' },
    },
    allowPositionals: true,
    strict: true,
  })
  const project = positionals[0]
  const files = positionals.slice(1)
  if (!values.message || !project || files.length === 0) {
    console.error(usage)
    return 1
  }

  const client = await connectConfiguredForemanClient(values.config)
  try {
    const result = await client.project.commit({
      project,
      ...(values.worktree === undefined ? {} : { worktree_id: values.worktree }),
      message: values.message,
      files,
    })
    writeServicePayload(servicePayload(result))
    return result.hash ? 0 : 1
  } finally {
    client.close()
  }
}

export async function handleProjectRegister(args: string[]): Promise<number> {
  const usage = 'Usage: wrenyard project register <project> --description <text> [--display-name <text>] [--checkout <path>] [--remote <url>] [--default-branch <name>] [--config path] [--json]'
  if (isHelpRequest(args)) {
    console.log(usage)
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      json: { type: 'boolean' },
      description: { type: 'string' },
      'display-name': { type: 'string' },
      checkout: { type: 'string' },
      remote: { type: 'string' },
      'default-branch': { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  })
  const project = requireSinglePositional(positionals, usage)
  if (!values.description) {
    console.error(usage)
    return 1
  }

  const client = await connectConfiguredForemanClient(values.config)
  try {
    const result = await client.project.register({
      project,
      description: values.description,
      ...(values['display-name'] === undefined ? {} : { display_name: values['display-name'] }),
      ...(values.checkout === undefined ? {} : { checkout_path: values.checkout }),
      ...(values.remote === undefined ? {} : { git_remote: values.remote }),
      ...(values['default-branch'] === undefined ? {} : { default_branch: values['default-branch'] }),
    })
    writeServicePayload(servicePayload(result))
    return result.registered ? 0 : 1
  } finally {
    client.close()
  }
}

export async function handleProjectWorktree(args: string[]): Promise<number> {
  const subcommand = args[0]
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log('Usage: wrenyard project worktree <list|create|remove|merge> ...')
    return subcommand ? 0 : 1
  }
  if (subcommand === 'list') return handleProjectWorktreeList(args.slice(1))
  if (subcommand === 'create') return handleProjectWorktreeCreate(args.slice(1))
  if (subcommand === 'remove') return handleProjectWorktreeRemove(args.slice(1))
  if (subcommand === 'merge') return handleProjectWorktreeMerge(args.slice(1))
  console.error('Usage: wrenyard project worktree <list|create|remove|merge> ...')
  return 1
}

export async function handleProjectWorktreeList(args: string[]): Promise<number> {
  if (isHelpRequest(args)) {
    console.log('Usage: wrenyard project worktree list <project> [--config path] [--json]')
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' }, json: { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  })
  const project = requireSinglePositional(positionals, 'wrenyard project worktree list <project> [--config path] [--json]')

  const client = await connectConfiguredForemanClient(values.config)
  try {
    writeServicePayload(servicePayload(await client.project.worktree.list({ project })))
    return 0
  } finally {
    client.close()
  }
}

export async function handleProjectWorktreeCreate(args: string[]): Promise<number> {
  if (isHelpRequest(args)) {
    console.log('Usage: wrenyard project worktree create <project> <worktree_id> [--config path] [--json]')
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' }, json: { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length !== 2) {
    console.error('Usage: wrenyard project worktree create <project> <worktree_id> [--config path] [--json]')
    return 1
  }
  const [project, worktreeId] = positionals

  const client = await connectConfiguredForemanClient(values.config)
  try {
    writeServicePayload(servicePayload(await client.project.worktree.create({ project, worktree_id: worktreeId })))
    return 0
  } finally {
    client.close()
  }
}

export async function handleProjectWorktreeRemove(args: string[]): Promise<number> {
  if (isHelpRequest(args)) {
    console.log('Usage: wrenyard project worktree remove <worktree_id> [--config path] [--json]')
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' }, json: { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  })
  const worktreeId = requireSinglePositional(positionals, 'wrenyard project worktree remove <worktree_id> [--config path] [--json]')

  const client = await connectConfiguredForemanClient(values.config)
  try {
    const result = await client.project.worktree.remove({ worktree_id: worktreeId })
    writeServicePayload(servicePayload(result))
    return result.removed ? 0 : 1
  } finally {
    client.close()
  }
}

export async function handleProjectWorktreeMerge(args: string[]): Promise<number> {
  if (isHelpRequest(args)) {
    console.log('Usage: wrenyard project worktree merge <project> <worktree_id> [--config path] [--json]')
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' }, json: { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length !== 2) {
    console.error('Usage: wrenyard project worktree merge <project> <worktree_id> [--config path] [--json]')
    return 1
  }
  const [project, worktreeId] = positionals

  const client = await connectConfiguredForemanClient(values.config)
  try {
    const result = await client.project.worktree.merge({ project, worktree_id: worktreeId })
    writeServicePayload(servicePayload(result))
    return result.merged && result.removed ? 0 : 1
  } finally {
    client.close()
  }
}
