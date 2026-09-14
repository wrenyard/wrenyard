import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

// Fixture used by forge-client-readiness-query tests. It emulates the output of
// `forge doctor clients --json` for each controlled mode. It never inspects its
// argv beyond reporting it, so the test can assert the exact command shape.
const mode = process.env.WRENYARD_TEST_CLIENT_READINESS_MODE
const argv = process.argv.slice(2)

if (mode === 'ok') {
  process.stdout.write(JSON.stringify({
    schema_version: 1,
    ok: true,
    adapters: ['clients'],
    checks: [
      {
        adapter: 'clients',
        status: 'ok',
        message: 'Configured clients are installed or disabled.',
        details: {
          claude: { enabled: true, installed: true },
          codex: { enabled: true, installed: false },
          grok: { enabled: false, installed: true },
        },
      },
    ],
    summary: { ok: 1, warning: 0, error: 0 },
  }))
} else if (mode === 'args') {
  // Echo the observed argv under a known-safe status so the test can prove the
  // exact command shape without relying on the parsed projection.
  if (argv.join(' ') !== 'doctor clients --json') {
    process.stderr.write(`unexpected argv: ${JSON.stringify(argv)}`)
    process.exit(9)
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    checks: [{ adapter: 'clients', status: 'ok', details: { claude: { enabled: true, installed: true } } }],
  }))
} else if (mode === 'invalid') {
  process.stdout.write(JSON.stringify({
    ok: true,
    checks: [{ adapter: 'clients', status: 'ok', details: { claude: { enabled: 'yes', installed: true } } }],
  }))
} else if (mode === 'error-report') {
  process.stdout.write(JSON.stringify({
    ok: false,
    checks: [{ adapter: 'clients', status: 'error', details: { claude: { enabled: true, installed: false } } }],
  }))
} else if (mode === 'error') {
  process.stderr.write('sensitive-client-readiness-detail')
  process.exitCode = 7
} else if (mode === 'overflow') {
  process.stdout.write('x'.repeat(64 * 1024))
} else if (mode === 'hang') {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const marker = process.env.WRENYARD_TEST_CLIENT_READINESS_MARKER
  if (marker) writeFileSync(marker, String(grandchild.pid))
  setInterval(() => {}, 1_000)
} else {
  process.exitCode = 2
}
