import { spawn } from 'node:child_process'
import type { MessageBackend } from '../../../message/delivery/hub.mts'
import type { MessageDeliveryResult, MessageEnvelope, OpenclawChannelConfig } from '../../../message/delivery/types.mts'
import { formatMessageDeliveryTexts, formatSessionStamp, type MessageDeliveryFormatInput } from '../../../message/delivery/format.mts'
import { prepareMediaForTelegram, MAX_TELEGRAM_MEDIA_BYTES } from './media-helpers.mts'

const OPENCLAW_MESSAGE_TIMEOUT_MS = 15_000
const OPENCLAW_MEDIA_MESSAGE_TIMEOUT_MS = 60_000
const OPENCLAW_AGENT_MESSAGE_TIMEOUT_SECONDS = 120

export { MAX_TELEGRAM_MEDIA_BYTES }

export interface CommandRunner {
  (binary: string, args: string[], options: { timeoutMs: number; errorPrefix: string }): Promise<void>
}

export interface MediaPreparer {
  (mediaPath: string): Promise<string>
}

function killProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).unref()
      return
    }
    process.kill(-pid, signal)
  } catch {
    try { process.kill(pid, signal) } catch { /* best-effort */ }
  }
}

export function runCommandWithTimeout(
  binary: string,
  args: string[],
  options: { timeoutMs: number; errorPrefix: string },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let forceKillTimer: NodeJS.Timeout | null = null

    const timeoutTimer = setTimeout(() => {
      timedOut = true
      killProcessTree(child.pid, 'SIGTERM')
      forceKillTimer = setTimeout(() => {
        killProcessTree(child.pid, 'SIGKILL')
      }, 1_000)
    }, options.timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })

    child.on('error', (err) => {
      clearTimeout(timeoutTimer)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      reject(new Error(`${options.errorPrefix} failed to start: ${err.message}`))
    })

    child.on('exit', (code, signal) => {
      clearTimeout(timeoutTimer)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      if (timedOut) {
        reject(new Error(`${options.errorPrefix} timed out after ${options.timeoutMs}ms`))
        return
      }
      if (code === 0) {
        resolve()
        return
      }
      const detail = (stderr || stdout).trim()
      reject(new Error(`${options.errorPrefix} failed${code === null ? '' : ` with exit code ${code}`}${signal ? ` (${signal})` : ''}${detail ? `: ${detail}` : ''}`))
    })
  })
}

function openclawIdempotencyKey(input: OpenclawInput): string {
  if (input.sessionId && input.turnId) {
    return `foreman:${input.sessionId}:${input.turnId}`
  }
  return `foreman:${input.eventId}`
}

export interface OpenclawInput extends MessageDeliveryFormatInput {
  eventId: string
  sessionId?: string
  mediaPath?: string | null
}

export function buildOpenclawMessageArgs(
  config: OpenclawChannelConfig,
  input: OpenclawInput,
  options: { idempotencyKeySuffix?: string } = {},
): string[] {
  return buildOpenclawMessageArgBatches(config, input, options)[0]
}

export function buildOpenclawMessageArgBatches(
  config: OpenclawChannelConfig,
  input: OpenclawInput,
  options: { idempotencyKeySuffix?: string } = {},
): string[][] {
  const isAgentMode = config.mode === 'agent'
  const messageInput = isAgentMode
    ? { ...inputWithMediaPathInSummary(input), originSession: undefined }
    : input
  const messages = formatMessageDeliveryTexts(messageInput)
  return messages.map((message, index) => {
    const partSuffix = messages.length > 1 ? `:part-${index + 1}-of-${messages.length}` : ''
    const idempotencyKeySuffix = `${options.idempotencyKeySuffix ?? ''}${partSuffix}`
    const mediaPath = !isAgentMode && index === 0 ? input.mediaPath ?? null : null
    return isAgentMode
      ? buildOpenclawAgentMessageArgsForMessage(config, messageInput, message, { idempotencyKeySuffix })
      : buildOpenclawMessageArgsForMessage(config, input, message, mediaPath, { idempotencyKeySuffix })
  })
}

function inputWithMediaPathInSummary(input: OpenclawInput): OpenclawInput {
  if (!input.mediaPath) return input
  return {
    ...input,
    summary: [input.summary.trim(), `Media: ${input.mediaPath}`].filter(Boolean).join('\n\n'),
    mediaPath: null,
  }
}

function buildOpenclawMessageArgsForMessage(
  config: OpenclawChannelConfig,
  input: OpenclawInput,
  message: string,
  mediaPath: string | null,
  options: { idempotencyKeySuffix?: string } = {},
): string[] {
  const params: Record<string, string> = {
    to: config.target ?? '',
    message,
    channel: config.channel ?? '',
    idempotencyKey: `${openclawIdempotencyKey(input)}${options.idempotencyKeySuffix ?? ''}`,
  }
  if (mediaPath) {
    params.mediaUrl = mediaPath
  }
  return [
    'gateway', 'call', 'send', '--params',
    JSON.stringify(params),
    '--json', '--timeout',
    String(openclawMessageTimeoutMsForMediaPath(mediaPath)),
  ]
}

function buildOpenclawAgentMessageArgsForMessage(
  config: OpenclawChannelConfig,
  input: OpenclawInput,
  message: string,
  options: { idempotencyKeySuffix?: string } = {},
): string[] {
  if (!config.session_key) {
    throw new Error('openclaw agent message requires openclaw.session_key')
  }
  const params: Record<string, string | boolean> = {
    sessionKey: config.session_key,
    message,
    deliver: true,
    idempotencyKey: `${openclawIdempotencyKey(input)}${options.idempotencyKeySuffix ?? ''}`,
  }
  if (config.model) {
    params.model = config.model
  }
  return [
    'gateway', 'call', 'chat.send', '--params',
    JSON.stringify(params),
    '--json', '--timeout',
    String(openclawAgentMessageTimeoutMs(config)),
  ]
}

export function openclawMessageTimeoutMs(mediaPath: string | null): number {
  return openclawMessageTimeoutMsForMediaPath(mediaPath)
}

function openclawMessageTimeoutMsForMediaPath(mediaPath: string | null): number {
  return mediaPath ? OPENCLAW_MEDIA_MESSAGE_TIMEOUT_MS : OPENCLAW_MESSAGE_TIMEOUT_MS
}

function openclawMessageTimeoutMsForArgs(args: string[]): number {
  if (args[0] === 'gateway') return Number(args[7])
  const timeoutIndex = args.indexOf('--timeout')
  if (timeoutIndex >= 0 && timeoutIndex + 1 < args.length) {
    const timeoutSeconds = Number(args[timeoutIndex + 1])
    if (Number.isFinite(timeoutSeconds) && timeoutSeconds >= 0) {
      return timeoutSeconds * 1000
    }
  }
  return OPENCLAW_MESSAGE_TIMEOUT_MS
}

function openclawAgentMessageTimeoutMs(config: OpenclawChannelConfig): number {
  return (config.timeout ?? OPENCLAW_AGENT_MESSAGE_TIMEOUT_SECONDS) * 1000
}

export function buildMediaFallbackInput(input: OpenclawInput): OpenclawInput {
  const notice = [
    '视频附件上传失败，已改发纯文本消息。',
    input.mediaPath ? `视频文件：${input.mediaPath}` : null,
  ].filter((line): line is string => Boolean(line)).join('\n')
  return {
    ...input,
    summary: [notice, input.summary.trim()].filter(Boolean).join('\n\n'),
    mediaPath: null,
  }
}

function inputFromEvent(event: MessageEnvelope): OpenclawInput {
  return {
    eventId: event.id,
    taskName: event.title,
    status: event.kind === 'task.done' || event.kind === 'flow.done' ? 'done'
      : event.kind === 'task.failed' || event.kind === 'flow.failed' ? 'failed'
      : 'done',
    client: null,
    model: null,
    sessionId: event.refs.sessionId,
    turnId: event.refs.taskId,
    prUrl: null,
    duration: '',
    summary: event.body,
    mediaPath: event.media ?? null,
    originSession: event.refs.originSession ? formatSessionStamp(event.refs.originSession) : undefined,
  }
}

export function createOpenclawBackend(
  config: OpenclawChannelConfig,
  runCommand: CommandRunner = runCommandWithTimeout,
  prepareMedia: MediaPreparer = prepareMediaForTelegram,
): MessageBackend {
  return {
    name: 'openclaw',
    async deliver(event, channel): Promise<MessageDeliveryResult> {
      let mediaDelivered = false
      let input = inputFromEvent(event)
      try {
        if (input.mediaPath && config.mode !== 'agent') {
          input = {
            ...input,
            mediaPath: await prepareMedia(input.mediaPath),
          }
        }
        for (const args of buildOpenclawMessageArgBatches(config, input)) {
          const params = args[0] === 'gateway' ? JSON.parse(args[4]) as { mediaUrl?: unknown } : {}
          await runCommand('openclaw', args, {
            timeoutMs: openclawMessageTimeoutMsForArgs(args),
            errorPrefix: 'openclaw message',
          })
          if (params.mediaUrl) mediaDelivered = true
        }
        return { channel, backend: 'openclaw', ok: true }
      } catch (mediaError) {
        if (!input.mediaPath || mediaDelivered) {
          return { channel, backend: 'openclaw', ok: false, error: (mediaError as Error).message }
        }
        const fallbackInput = buildMediaFallbackInput(input)
        try {
          for (const args of buildOpenclawMessageArgBatches(config, fallbackInput, {
            idempotencyKeySuffix: ':media-fallback',
          })) {
            await runCommand('openclaw', args, {
              timeoutMs: openclawMessageTimeoutMsForArgs(args),
              errorPrefix: 'openclaw message fallback',
            })
          }
          return { channel, backend: 'openclaw', ok: true }
        } catch (fallbackError) {
          return {
            channel,
            backend: 'openclaw',
            ok: false,
            error: `${(mediaError as Error).message}; fallback failed: ${(fallbackError as Error).message}`,
          }
        }
      }
    },
  }
}
