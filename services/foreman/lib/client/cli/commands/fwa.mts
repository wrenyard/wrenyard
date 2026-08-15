/**
 * Concise operator CLI verbs for native FWA operations.
 */

import { parseArgs } from 'node:util'
import type {
  FwaAssignParams,
  FwaStatusParams,
  FwaTranscriptParams,
} from '../../../protocol/methods/fwa.mts'
import {
  connectConfiguredForemanClient,
  isHelpRequest,
  servicePayload,
  writeServicePayload,
} from '../shared.mts'

/**
 * Safely render the --config flag for copyable suggestion commands.
 * Returns an empty string when no config path is set, preserving ergonomics
 * for users who rely on the default XDG config path.
 */
function renderConfigFlag(values: { config?: string }): string {
  return values.config ? ` --config ${JSON.stringify(values.config)}` : ''
}

export async function handleFwa(args: string[]): Promise<number> {
  const subcommand = args[0]
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.error('Usage: wrenyard fwa <assign|list|status|transcript> ...')
    return subcommand ? 0 : 1
  }
  if (subcommand === 'assign') return handleFwaAssign(args.slice(1))
  if (subcommand === 'list') return handleFwaList(args.slice(1))
  if (subcommand === 'status') return handleFwaStatus(args.slice(1))
  if (subcommand === 'transcript') return handleFwaTranscript(args.slice(1))
  console.error('Usage: wrenyard fwa <assign|list|status|transcript> ...')
  return 1
}

async function handleFwaAssign(args: string[]): Promise<number> {
  const usage = 'wrenyard fwa assign <ticket_id> <project_id> <prompt> [--config path] [--json]'
  if (isHelpRequest(args)) {
    console.log(`Usage: ${usage}`)
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' }, json: { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length < 3) {
    console.error(`Usage: ${usage}`)
    return 1
  }
  const params: FwaAssignParams = {
    ticket_id: positionals[0],
    project_id: positionals[1],
    prompt: positionals.slice(2).join(' '),
  }
  const client = await connectConfiguredForemanClient(values.config)
  try {
    const result = await client.fwa.assign(params)
    if (values.json) {
      writeServicePayload(servicePayload(result))
    } else {
      const s = result.session
      console.log(`Session:      ${s.id}`)
      console.log(`Ticket:       ${s.ticket_id}`)
      console.log(`Project:      ${s.project_id}`)
      console.log(`Status:       ${s.status}`)
      console.log(`Queue depth:  ${s.queue_depth}`)
      console.log('')
      const configFlag = renderConfigFlag(values)
      console.log(`Inspect status:       wrenyard fwa status ${s.id}${configFlag}`)
      console.log(`Inspect transcript:  wrenyard fwa transcript ${s.id}${configFlag}`)
    }
    return 0
  } finally {
    client.close()
  }
}

async function handleFwaList(args: string[]): Promise<number> {
  const usage = 'wrenyard fwa list [--config path] [--json]'
  if (isHelpRequest(args)) {
    console.log(`Usage: ${usage}`)
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' }, json: { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  })
  const client = await connectConfiguredForemanClient(values.config)
  try {
    const result = await client.fwa.list()
    writeServicePayload(servicePayload(result))
    return 0
  } finally {
    client.close()
  }
}

async function handleFwaStatus(args: string[]): Promise<number> {
  const usage = 'wrenyard fwa status <session_id> [--config path] [--json]'
  if (isHelpRequest(args)) {
    console.log(`Usage: ${usage}`)
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' }, json: { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length < 1) {
    console.error(`Usage: ${usage}`)
    return 1
  }
  const params: FwaStatusParams = { session_id: positionals[0] }
  const client = await connectConfiguredForemanClient(values.config)
  try {
    const result = await client.fwa.status(params)
    if (values.json) {
      writeServicePayload(servicePayload(result))
    } else {
      const s = result
      const sessionId = s.session_id
      const configFlag = renderConfigFlag(values)
      console.log(`Session:      ${sessionId}`)
      console.log(`Ticket:       ${s.ticket_id}`)
      console.log(`Project:      ${s.project_id}`)
      console.log(`Status:       ${s.status}`)
      console.log(`Queue depth:  ${s.queue_depth}`)
      console.log(`Active turn:  ${s.active_turn_seq ?? '(none)'}`)
      console.log(`Last error:   ${s.last_error ?? '(none)'}`)
      console.log(`Graph refs:   ${(s.graph_refs as string[] ?? []).join(', ') || '(none)'}`)
      console.log(`Task refs:    ${(s.task_refs as string[] ?? []).join(', ') || '(none)'}`)
      console.log(`Created:      ${s.created_at}`)
      console.log(`Updated:      ${s.updated_at}`)
      console.log('')
      console.log(`Inspect transcript:     wrenyard fwa transcript ${sessionId}${configFlag}`)
      const graphRefs = s.graph_refs as string[] ?? []
      if (graphRefs.length > 0) {
        console.log('')
        for (const ref of graphRefs) {
          console.log(`TaskGraph journal:      wrenyard taskgraph status '${JSON.stringify({ taskgraph_id: ref })}'${configFlag}`)
          console.log(`TaskGraph events:       wrenyard taskgraph events '${JSON.stringify({ taskgraph_id: ref })}'${configFlag}`)
        }
      }
      const taskRefs = s.task_refs as string[] ?? []
      if (taskRefs.length > 0) {
        console.log('')
        for (const ref of taskRefs) {
          console.log(`Task output:            wrenyard task output ${ref}${configFlag}`)
        }
      }
    }
    return 0
  } finally {
    client.close()
  }
}

async function handleFwaTranscript(args: string[]): Promise<number> {
  const usage = 'wrenyard fwa transcript <session_id> [--config path] [--json]'
  if (isHelpRequest(args)) {
    console.log(`Usage: ${usage}`)
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' }, json: { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length < 1) {
    console.error(`Usage: ${usage}`)
    return 1
  }
  const params: FwaTranscriptParams = { session_id: positionals[0] }
  const client = await connectConfiguredForemanClient(values.config)
  try {
    const result = await client.fwa.transcript(params)
    writeServicePayload(servicePayload(result))
    return 0
  } finally {
    client.close()
  }
}
