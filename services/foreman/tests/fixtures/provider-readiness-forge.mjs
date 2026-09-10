import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const mode = process.env.WRENYARD_TEST_PROVIDER_READINESS_MODE

if (mode === 'ok') {
  process.stdout.write(JSON.stringify([
    { id: 'chatgpt', auth_ok: true, api_kind: 'openai-chat-completions', extra: 'ignored' },
    { id: 'cursor', auth_ok: false, api_kind: '' },
  ]))
} else if (mode === 'error') {
  process.stderr.write('sensitive-provider-status-detail')
  process.exitCode = 7
} else if (mode === 'overflow') {
  process.stdout.write('x'.repeat(64 * 1024))
} else if (mode === 'hang') {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const marker = process.env.WRENYARD_TEST_PROVIDER_READINESS_MARKER
  if (marker) writeFileSync(marker, String(grandchild.pid))
  setInterval(() => {}, 1_000)
} else {
  process.exitCode = 2
}
