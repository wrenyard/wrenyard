import { appendFileSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { foremanStateRoot } from '../config/state.mts'

/**
 * Root directory for Foreman application logs under the XDG state tree.
 */
export function foremanLogsRoot(): string {
  return join(foremanStateRoot(), 'logs')
}

export function appendLogJsonl(scope: string, filename: string, value: unknown): void {
  const file = join(foremanLogsRoot(), scope, filename)
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8')
}

export function appendDailyLogJsonl(date: string, filename: string, value: unknown): void {
  appendLogJsonl(join('daily', date), filename, value)
}

export function writeDailyHandoffFile(input: {
  date: string
  sessionId: string
  busy?: boolean
  now: Date
}): { ok: true; path: string } | { ok: false; error: string; path?: string } {
  const dailyDir = join(foremanLogsRoot(), 'daily', input.date)
  mkdirSync(dailyDir, { recursive: true })
  if (input.busy) {
    const path = join(dailyDir, 'handoff.delayed.json')
    writeFileSync(path, JSON.stringify({
      ok: false,
      error: 'busy',
      reason: 'daily foreman session is currently running',
      at: input.now.toISOString(),
    }, null, 2) + '\n', 'utf8')
    return { ok: false, error: 'busy', path }
  }

  const inbox = readIfExists(join(dailyDir, 'inbox.jsonl'))
  const outbox = readIfExists(join(dailyDir, 'outbox.jsonl'))
  const results = readIfExists(join(dailyDir, 'results.jsonl'))
  const path = join(dailyDir, 'handoff.md')
  const body = [
    `# Foreman Daily Handoff ${input.date}`,
    '',
    `Session: ${input.sessionId}`,
    '',
    '## Inbox',
    inbox || 'No inbound messages recorded.',
    '',
    '## Outbox',
    outbox || 'No outbound messages recorded.',
    '',
    '## Results',
    results || 'No remote results recorded.',
    '',
  ].join('\n')
  writeFileSync(path, body, 'utf8')
  return { ok: true, path }
}

function readIfExists(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : ''
}
