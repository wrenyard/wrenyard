import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DaemonProcess } from '../lib/supervisor.mjs'

// A stand-in `daemon run` child: announces readiness over the owned Node IPC
// channel, exits 0 on the `shutdown` fallback message and exits 7 on `crash`.
const FAKE_DAEMON = `
process.send('ready')
process.on('message', (message) => {
  if (message === 'shutdown') process.exit(0)
  if (message === 'crash') process.exit(7)
})
setInterval(() => {}, 1000)
`

// No daemon listens here, so shutdown falls back to the owned IPC channel.
const UNUSED_IPC = process.platform === 'win32'
  ? `\\\\.\\pipe\\wrenyard-supervisor-test-${process.pid}`
  : `/tmp/wrenyard-supervisor-test-${process.pid}.sock`

type ExitInfo = { code: number | null, signal: string | null, expected: boolean }

function fakeDaemon(onExit: (info: ExitInfo) => void, script = FAKE_DAEMON) {
  return new DaemonProcess({
    command: process.execPath,
    args: ['-e', script],
    ipcPath: UNUSED_IPC,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    probe: async () => false,
    readyTimeoutMs: 5_000,
    onExit,
  })
}

describe('DaemonProcess', () => {
  it('launches on the ready message and reports a graceful shutdown as expected', async () => {
    const exits: ExitInfo[] = []
    const daemon = fakeDaemon((info) => exits.push(info))
    await daemon.launch()
    assert.equal(daemon.running, true)

    assert.equal(await daemon.shutdown({ timeoutMs: 5_000 }), true)
    assert.equal(daemon.running, false)
    assert.deepEqual(exits, [{ code: 0, signal: null, expected: true }])
  })

  it('reports an unrequested exit as a crash', async () => {
    const exits: ExitInfo[] = []
    const daemon = fakeDaemon((info) => exits.push(info))
    await daemon.launch()

    daemon.child?.send('crash')
    assert.equal(await daemon.waitForExit(5_000), true)
    assert.deepEqual(exits, [{ code: 7, signal: null, expected: false }])
  })

  it('rejects a child that exits before readiness without reporting a crash', async () => {
    const exits: ExitInfo[] = []
    const daemon = fakeDaemon((info) => exits.push(info), 'process.exit(3)')
    await assert.rejects(daemon.launch(), /exited before it became ready/)
    assert.deepEqual(exits, [])
  })
})
