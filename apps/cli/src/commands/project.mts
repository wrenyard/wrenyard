
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
    console.log('Usage: wrenyard project <list|describe|status|pull|push|worktree> ...')
    return subcommand ? 0 : 1
  }

  if (subcommand === 'list') return handleProjectList(args.slice(1))
  if (subcommand === 'describe') return handleProjectDescribe(args.slice(1))
  if (subcommand === 'status') return handleProjectStatus(args.slice(1))
  if (subcommand === 'pull') return handleProjectPull(args.slice(1))
  if (subcommand === 'push') return handleProjectPush(args.slice(1))
  if (subcommand === 'worktree') return handleProjectWorktree(args.slice(1))

  console.error('Usage: wrenyard project <list|describe|status|pull|push|worktree> ...')
  return 1
}

export async function handleProjectList(args: string[]): Promise<number> {
  if (isHelpRequest(args)) {
    console.log('Usage: wrenyard project list [--config path]')
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  })
  requireNoPositionals(positionals, 'wrenyard project list [--config path]')

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
    console.log('Usage: wrenyard project describe <project> [--config path]')
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  })
  const project = requireSinglePositional(positionals, 'wrenyard project describe <project> [--config path]')

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
    console.log('Usage: wrenyard project status <project> [--config path]')
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  })
  const project = requireSinglePositional(positionals, 'wrenyard project status <project> [--config path]')

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
    console.log('Usage: wrenyard project pull <project> [--config path]')
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  })
  const project = requireSinglePositional(positionals, 'wrenyard project pull <project> [--config path]')

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
    console.log('Usage: wrenyard project push <project> [--config path]')
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  })
  const project = requireSinglePositional(positionals, 'wrenyard project push <project> [--config path]')

  const client = await connectConfiguredForemanClient(values.config)
  try {
    const result = await client.project.push({ project })
    writeServicePayload(servicePayload(result))
    return result.pushed ? 0 : 1
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
    console.log('Usage: wrenyard project worktree list <project> [--config path]')
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  })
  const project = requireSinglePositional(positionals, 'wrenyard project worktree list <project> [--config path]')

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
    console.log('Usage: wrenyard project worktree create <project> <worktree_id> [--config path]')
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length !== 2) {
    console.error('Usage: wrenyard project worktree create <project> <worktree_id> [--config path]')
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
    console.log('Usage: wrenyard project worktree remove <worktree_id> [--config path]')
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  })
  const worktreeId = requireSinglePositional(positionals, 'wrenyard project worktree remove <worktree_id> [--config path]')

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
    console.log('Usage: wrenyard project worktree merge <project> <worktree_id> [--config path]')
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length !== 2) {
    console.error('Usage: wrenyard project worktree merge <project> <worktree_id> [--config path]')
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
