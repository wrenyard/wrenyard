import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { parseRunSyntax } from '@wrenyard/providers/catalog'
import {
  connectConfiguredForemanClient,
  errorMessage,
  isHelpRequest,
  servicePayload,
  writeServicePayload,
  type IpcForemanClient,
} from '../shared.mts'
import type { ExecSnapshot } from '../../../protocol/methods/exec.mts'

const TERMINAL_STATUSES = new Set<ExecSnapshot['status']>(['completed', 'failed', 'cancelled'])

const USAGE = 'Usage: wrenyard exec <prompt> --target <provider/model:client> [--cwd path] [--resume <session-id>] [--thinking <level>] [--features a,b] [--config path] [--json] [--no-stream]'

/**
 * `wrenyard exec` runs one RAW PROMPT through the daemon's exec surface.
 *
 * The prompt is passed through verbatim; it is never parsed as a task. The
 * target is a public `provider/model:client` run syntax resolved against the
 * live provider catalog exactly the way a task dispatch target is, so the CLI
 * never invents a model id. Events stream by polling `exec.events`; the run can
 * be cancelled at any time with Ctrl+C, which issues `exec.cancel`.
 */
export async function handleExec(args: string[]): Promise<number> {
  if (isHelpRequest(args)) {
    console.log(USAGE)
    return 0
  }

  const { values, positionals } = parseArgs({
    args,
    options: {
      target: { type: 'string' },
      cwd: { type: 'string' },
      resume: { type: 'string' },
      thinking: { type: 'string' },
      features: { type: 'string' },
      config: { type: 'string' },
      json: { type: 'boolean' },
      'no-stream': { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  })

  const prompt = positionals.join(' ').trim()
  const target = typeof values.target === 'string' ? values.target.trim() : ''
  if (!prompt || !target) {
    console.error(USAGE)
    return 1
  }

  const client = await connectConfiguredForemanClient(values.config)
  let cancelling = false
  let activeExecutionId: string | undefined
  // Ctrl+C is cooperative cancellation, never a hard exit: the SIGINT listener
  // suppresses the default termination so the poll loop observes the terminal
  // `cancelled` snapshot before the CLI returns.
  const onSignal = (): void => {
    if (cancelling) return
    cancelling = true
    if (activeExecutionId) {
      void client.exec.cancel({ id: activeExecutionId }).catch(() => undefined)
    }
  }
  process.on('SIGINT', onSignal)

  try {
    const resolved = await resolveExecTarget(client, target)
    const features = parseFeatureList(values.features)

    const started = await client.exec.start({
      client: resolved.client,
      provider: resolved.provider,
      model: resolved.model,
      prompt,
      cwd: resolve(typeof values.cwd === 'string' && values.cwd.trim() ? values.cwd : process.cwd()),
      ...(resolved.mode === undefined ? {} : { mode: resolved.mode }),
      ...(typeof values.resume === 'string' && values.resume.trim() ? { resumeSessionId: values.resume.trim() } : {}),
      ...(typeof values.thinking === 'string' && values.thinking.trim() ? { thinking: values.thinking.trim() } : {}),
      ...(features.length > 0 ? { features } : {}),
    })
    activeExecutionId = started.execution.id
    if (cancelRequested) await client.exec.cancel({ id: activeExecutionId })

    if (values['no-stream']) {
      writeServicePayload(servicePayload(started))
      return 0
    }

    const status = await streamExecution(client, started.execution.id, values.json === true)
    return status === 'completed' ? 0 : 1
  } finally {
    process.removeListener('SIGINT', onSignal)
    client.close()
  }
}

interface ResolvedExecTarget {
  client: string
  provider: string
  model: string
  mode?: 'native' | 'gateway'
}

/**
 * Resolve a public `provider/model:client` target against the live catalog.
 *
 * The client comes from the syntax itself; the model must exist in the
 * resolved provider's catalog listing, and its canonical id (when the catalog
 * pairs one) is what the exec request carries. A model that the catalog does
 * not advertise is rejected before anything is started, so the CLI never
 * fabricates a wire model id.
 */
async function resolveExecTarget(client: IpcForemanClient, target: string): Promise<ResolvedExecTarget> {
  let syntax
  try {
    syntax = parseRunSyntax(target)
  } catch (error) {
    throw new Error(`Invalid --target '${target}': ${errorMessage(error)}`)
  }
  const providers = await client.provider.list()
  const provider = providers.providers.find((entry) => entry.id === syntax.provider)
  if (!provider) {
    throw new Error(`Unknown provider '${syntax.provider}' in target '${target}'`)
  }
  const model = provider.models.find((entry) => entry.id === syntax.model)
  if (!model) {
    throw new Error(`Unknown model '${syntax.model}' for provider '${syntax.provider}'`)
  }
  return {
    client: syntax.client,
    provider: syntax.provider,
    model: model.canonicalId ?? model.id,
  }
}

/**
 * Follow one execution to its terminal state by polling `exec.events`.
 *
 * Events are printed in order; when `--json` is set the raw envelope is
 * emitted so downstream tooling can consume the normalized agent records. The
 * loop terminates on the snapshot's terminal status, and it never advances
 * past the observed `nextSeq` cursor.
 */
async function streamExecution(client: IpcForemanClient, id: string, json: boolean): Promise<ExecSnapshot['status']> {
  let cursor = 0
  for (;;) {
    const page = await client.exec.events({ id, afterSeq: cursor })
    for (const envelope of page.events) {
      if (json) {
        process.stdout.write(`${JSON.stringify(envelope)}\n`)
      } else {
        writeEventText(envelope.event)
      }
    }
    cursor = page.nextSeq

    const snapshot = await client.exec.get({ id })
    if (TERMINAL_STATUSES.has(snapshot.execution.status)) {
      const tail = await client.exec.events({ id, afterSeq: cursor })
      for (const envelope of tail.events) {
        if (json) process.stdout.write(`${JSON.stringify(envelope)}\n`)
        else writeEventText(envelope.event)
      }
      if (snapshot.execution.error) process.stderr.write(`${snapshot.execution.error}\n`)
      return snapshot.execution.status
    }
    await sleep(250)
  }
}

/** Best-effort human-readable projection of one normalized agent event record. */
function writeEventText(event: Record<string, unknown>): void {
  const type = typeof event.type === 'string' ? event.type : undefined
  if (type === 'stderr' && typeof event.text === 'string') {
    process.stderr.write(event.text)
    return
  }
  if (type === 'error' && typeof event.message === 'string') {
    process.stderr.write(`${event.message}\n`)
    return
  }
  if (type === 'exit') {
    const exitCode = typeof event.exitCode === 'number' ? event.exitCode : 'null'
    process.stderr.write(`[exec] exited with code ${exitCode}\n`)
    return
  }
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

function parseFeatureList(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  return raw.split(',').map((entry) => entry.trim()).filter(Boolean)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}
