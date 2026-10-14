
import { parseArgs } from 'node:util'
import { REASONING_EFFORTS, type ReasoningEffort } from '@wrenyard/models'
import {
  connectConfiguredForemanClient,
  isHelpRequest,
  servicePayload,
  writeServicePayload,
  type IpcForemanClient,
} from '../shared.mts'

type SessionEventsPage = Awaited<ReturnType<IpcForemanClient['session']['events']>>
type SessionLedgerEvent = SessionEventsPage['events'][number]

const SESSION_USAGE = 'Usage: wrenyard session <list|create|send|events|interrupt|delete> ...'

export async function handleSession(args: string[]): Promise<number> {
  const subcommand = args[0]
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.error(SESSION_USAGE)
    return subcommand ? 0 : 1
  }
  if (subcommand === 'list') return handleSessionList(args.slice(1))
  if (subcommand === 'create') return handleSessionCreate(args.slice(1))
  if (subcommand === 'send') return handleSessionSend(args.slice(1))
  if (subcommand === 'events') return handleSessionEvents(args.slice(1))
  if (subcommand === 'interrupt') return handleSessionInterrupt(args.slice(1))
  if (subcommand === 'delete') return handleSessionDelete(args.slice(1))
  console.error(SESSION_USAGE)
  return 1
}

export async function handleSessionList(args: string[]): Promise<number> {
  const usage = 'Usage: wrenyard session list [--config path] [--json]'
  if (isHelpRequest(args)) {
    console.log(usage)
    return 0
  }

  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length !== 0) {
    console.error(usage)
    return 1
  }

  const client = await connectConfiguredForemanClient(values.config)
  try {
    writeServicePayload(servicePayload(await client.session.list()))
    return 0
  } finally {
    client.close()
  }
}

export async function handleSessionCreate(args: string[]): Promise<number> {
  const usage = 'Usage: wrenyard session create [--config path] [--json]'
  if (isHelpRequest(args)) {
    console.log(usage)
    return 0
  }

  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length !== 0) {
    console.error(usage)
    return 1
  }

  const client = await connectConfiguredForemanClient(values.config)
  try {
    writeServicePayload(servicePayload(await client.session.create()))
    return 0
  } finally {
    client.close()
  }
}

export async function handleSessionSend(args: string[]): Promise<number> {
  const usage = 'Usage: wrenyard session send <sessionId> [text] --model <provider/model> --reasoning-effort <level> [--config path] [--json]'
  if (isHelpRequest(args)) {
    console.log(usage)
    console.log('  <text> may be passed as an argument; omit it (with piped stdin) or pass "-" to read the text from stdin.')
    console.log(`  Valid --reasoning-effort values: ${REASONING_EFFORTS.join(', ')}`)
    return 0
  }

  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      json: { type: 'boolean' },
      model: { type: 'string' },
      'reasoning-effort': { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length < 1 || positionals.length > 2) {
    console.error(usage)
    return 1
  }
  const sessionId = positionals[0]

  const modelRaw = typeof values.model === 'string' ? values.model : ''
  const slash = modelRaw.indexOf('/')
  if (slash <= 0 || slash === modelRaw.length - 1) {
    console.error(`--model must be <provider/model>: ${modelRaw}`)
    console.error(usage)
    return 1
  }
  const provider = modelRaw.slice(0, slash)
  const model = modelRaw.slice(slash + 1)

  const reasoningEffort = typeof values['reasoning-effort'] === 'string' ? values['reasoning-effort'] : ''
  if (!(REASONING_EFFORTS as readonly string[]).includes(reasoningEffort)) {
    console.error(`Unknown --reasoning-effort '${reasoningEffort}'; expected one of ${REASONING_EFFORTS.join(', ')}`)
    console.error(usage)
    return 1
  }
  const effort = reasoningEffort as ReasoningEffort

  const rawText = positionals[1]
  let text: string
  if (rawText === undefined) {
    if (process.stdin.isTTY === true) {
      console.error('wrenyard session send requires <text> or piped stdin')
      console.error(usage)
      return 1
    }
    text = await readStdinText()
  } else if (rawText === '-') {
    text = await readStdinText()
  } else {
    text = rawText
  }
  if (!text.trim()) {
    console.error('wrenyard session send requires non-empty text')
    console.error(usage)
    return 1
  }

  const client = await connectConfiguredForemanClient(values.config)
  try {
    const result = await client.session.send({
      sessionId,
      text,
      model: { provider, model, reasoningEffort: effort },
    })
    writeServicePayload(servicePayload({ turn: result.turn }))
    return 0
  } finally {
    client.close()
  }
}

export async function handleSessionEvents(args: string[]): Promise<number> {
  const usage = 'Usage: wrenyard session events <sessionId> [--after <seq>] [--follow] [--config path] [--json]'
  if (isHelpRequest(args)) {
    console.log(usage)
    console.log('  --json prints one ledger event per line (NDJSON).')
    console.log('  --follow keeps polling until Ctrl-C; the default drains the current snapshot and exits.')
    return 0
  }

  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      json: { type: 'boolean' },
      after: { type: 'string' },
      follow: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length !== 1) {
    console.error(usage)
    return 1
  }
  const sessionId = positionals[0]

  const afterRaw = typeof values.after === 'string' ? values.after : '0'
  if (!/^\d+$/u.test(afterRaw) || !Number.isSafeInteger(Number(afterRaw))) {
    console.error(`--after must be a nonnegative integer: ${afterRaw}`)
    console.error(usage)
    return 1
  }
  const afterSeq = Number(afterRaw)
  const follow = values.follow === true
  const json = values.json === true

  const client = await connectConfiguredForemanClient(values.config)
  let stopping = false
  const onSignal = (): void => {
    stopping = true
  }
  // Follow keeps polling until Ctrl+C. The handlers are only installed while
  // following and are always removed, so repeated invocations never accumulate
  // listeners and the default signal behavior is preserved otherwise.
  if (follow) {
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
  }
  try {
    await streamSessionEvents(client, sessionId, afterSeq, follow, json, () => stopping)
    return 0
  } finally {
    if (follow) {
      process.removeListener('SIGINT', onSignal)
      process.removeListener('SIGTERM', onSignal)
    }
    client.close()
  }
}

export async function handleSessionInterrupt(args: string[]): Promise<number> {
  const usage = 'Usage: wrenyard session interrupt <sessionId> [--config path] [--json]'
  if (isHelpRequest(args)) {
    console.log(usage)
    return 0
  }

  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length !== 1) {
    console.error(usage)
    return 1
  }
  const sessionId = positionals[0]

  const client = await connectConfiguredForemanClient(values.config)
  try {
    const events = await collectSessionLedger(client, sessionId)
    const turn = latestUnfinishedTurn(events)
    // No unfinished turn is a successful no-op, consistent with daemon
    // semantics: there is nothing to interrupt.
    if (turn === undefined) {
      writeServicePayload(servicePayload({}))
      return 0
    }
    await client.session.interrupt({ sessionId, turn })
    writeServicePayload(servicePayload({}))
    return 0
  } finally {
    client.close()
  }
}

export async function handleSessionDelete(args: string[]): Promise<number> {
  const usage = 'Usage: wrenyard session delete <sessionId> [--config path] [--json]'
  if (isHelpRequest(args)) {
    console.log(usage)
    return 0
  }

  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length !== 1) {
    console.error(usage)
    return 1
  }
  const sessionId = positionals[0]

  const client = await connectConfiguredForemanClient(values.config)
  try {
    await client.session.delete({ sessionId })
    writeServicePayload(servicePayload({}))
    return 0
  } finally {
    client.close()
  }
}

/**
 * Print ledger events for one session. In snapshot mode the first page's
 * `lastSeq` — the whole ledger tail, not the last event of the page — is the
 * boundary; every available page is drained until the emitted cursor reaches
 * it and newer events are ignored. `--follow` keeps long-polling until the
 * caller signals a stop.
 */
async function streamSessionEvents(
  client: IpcForemanClient,
  sessionId: string,
  afterSeq: number,
  follow: boolean,
  json: boolean,
  stopping: () => boolean,
): Promise<void> {
  let cursor = afterSeq
  let boundary: number | undefined
  for (;;) {
    if (stopping()) return
    const page = await client.session.events({ sessionId, afterSeq: cursor, waitMs: follow ? 1000 : 0 })
    if (!follow && boundary === undefined) boundary = page.lastSeq
    for (const event of page.events) {
      if (boundary !== undefined && event.seq > boundary) return
      if (json) process.stdout.write(`${JSON.stringify(event)}\n`)
      else writeServicePayload(servicePayload(event))
      cursor = event.seq
    }
    if (follow) continue
    // An empty page means there is nothing left to drain.
    if (page.events.length === 0) return
    if (boundary !== undefined && cursor >= boundary) return
  }
}

/**
 * Read the entire ledger snapshot from seq 0, advancing the cursor only to the
 * `seq` of the last event actually received so no event is ever skipped. The
 * first page's `lastSeq` is the snapshot boundary.
 */
async function collectSessionLedger(client: IpcForemanClient, sessionId: string): Promise<SessionLedgerEvent[]> {
  const events: SessionLedgerEvent[] = []
  let cursor = 0
  let boundary: number | undefined
  for (;;) {
    const page = await client.session.events({ sessionId, afterSeq: cursor, waitMs: 0 })
    if (boundary === undefined) boundary = page.lastSeq
    if (page.events.length === 0) break
    for (const event of page.events) {
      if (event.seq > boundary) return events
      events.push(event)
      cursor = event.seq
    }
    if (boundary !== undefined && cursor >= boundary) break
  }
  return events
}

/**
 * The highest `turn.started` with no matching `turn.finished`. `turn.interrupted`
 * is not terminal, so a turn that was interrupted mid-flight still counts as
 * unfinished until its terminal `turn.finished` lands.
 */
function latestUnfinishedTurn(events: SessionLedgerEvent[]): number | undefined {
  const finished = new Set<number>()
  for (const event of events) {
    if (event.type === 'turn.finished' && typeof event.turn === 'number') finished.add(event.turn)
  }
  let latest: number | undefined
  for (const event of events) {
    if (event.type === 'turn.started' && typeof event.turn === 'number' && !finished.has(event.turn)) {
      latest = event.turn
    }
  }
  return latest
}

function readStdinText(): Promise<string> {
  return (async () => {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    }
    return Buffer.concat(chunks).toString('utf8')
  })()
}
