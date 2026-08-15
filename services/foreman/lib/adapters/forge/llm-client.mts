import type { LlmInput, LlmOpts } from '../../types.mts'
import { spawnForge } from './exec.mts'

export interface ForgeLlmRunOptions extends LlmOpts {
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export function buildForgeLlmCommand(input: LlmInput, opts: LlmOpts = {}): string[] {
  const args = ['llm']
  if (opts.model) args.push('-m', opts.model)
  if (opts.timeoutMs !== undefined) args.push('--timeout-ms', String(opts.timeoutMs))
  if (opts.maxRetries !== undefined) args.push('--max-retries', String(opts.maxRetries))
  if (opts.retryBackoffMs !== undefined) args.push('--retry-backoff-ms', String(opts.retryBackoffMs))
  if (typeof input === 'string') {
    args.push('-p', input)
  } else {
    args.push('--protocol', opts.protocol ?? 'openai', '--stdin')
  }
  if (opts.maxTokens !== undefined) args.push('--max-tokens', String(opts.maxTokens))
  return args
}

/**
 * Serialize an object LLM input to a JSON string for stdin transport.
 * Exported so tests can assert the stdin payload without duplicate serialization.
 */
export function serializeLlmInput(input: LlmInput & object): string {
  return JSON.stringify(input)
}

export async function runForgeLlm(input: LlmInput, opts: ForgeLlmRunOptions = {}): Promise<string> {
  const args = buildForgeLlmCommand(input, opts)
  const useStdin = typeof input !== 'string'
  const child = spawnForge(args, {
    cwd: opts.cwd ?? process.cwd(),
    env: opts.env ?? process.env,
    stdio: useStdin ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  // Start consuming stdout/stderr and waiting for exit immediately after spawn
  // so no close/error event is missed (Fix: early child exit handling).
  const stdoutPromise = readStream(child.stdout)
  const stderrPromise = readStream(child.stderr)
  const exitPromise = waitForExit(child)

  // For object input, write and end stdin through a helper that listens for
  // stream error/close and rejects cleanly on early failure.
  let stdinPromise: Promise<void> | undefined
  if (useStdin && child.stdin) {
    stdinPromise = writeStdinAndEnd(child.stdin, serializeLlmInput(input))
  }

  // Await stdout, stderr, exit and stdin completion together.
  // stdin rejection (from early child exit / EPIPE) is caught so the
  // exit code always drives the error path.
  const [stdout, stderr, exit] = await Promise.all([
    stdoutPromise,
    stderrPromise,
    exitPromise,
    (stdinPromise ?? Promise.resolve()),
  ])

  if (exit.code !== 0) {
    const detail = stderr.trim() || stdout.trim() || (exit.signal ? `signal ${exit.signal}` : 'no output')
    throw new Error(`forge llm failed with exit code ${exit.code ?? 'null'}: ${tail(detail)}`)
  }

  return stdout.replace(/\s+$/u, '')
}

/**
 * Write payload to a stdin stream and end it, rejecting cleanly on write error
 * or stream close before the write completes. This prevents hangs when the
 * child process exits without reading stdin (e.g. early exit, spawn failure).
 */
function writeStdinAndEnd(stream: NodeJS.WritableStream, payload: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      cleanup()
      reject(err)
    }
    const onClose = () => {
      cleanup()
      reject(new Error('stdin stream closed before write completed'))
    }
    const cleanup = () => {
      stream.off('error', onError)
      stream.off('close', onClose)
    }
    stream.on('error', onError)
    stream.on('close', onClose)

    stream.write(payload, (err) => {
      if (err) {
        cleanup()
        reject(new Error(`forge llm stdin write failed: ${err.message}`))
        return
      }
      stream.end(() => {
        cleanup()
        resolve()
      })
    })
  })
}

async function readStream(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return ''
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  return Buffer.concat(chunks).toString('utf8')
}

function waitForExit(child: ReturnType<typeof spawnForge>): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
}

function tail(value: string): string {
  return value.length > 2000 ? value.slice(-2000) : value
}
