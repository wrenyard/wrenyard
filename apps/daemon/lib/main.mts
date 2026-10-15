import { runForemanService } from './server-bootstrap/service.mts'
import { parseStdioBridgeArgs, runStdioBridge } from './daemon/stdio-bridge.mts'

// The daemon process entry has two modes:
//  - `run [--config <path>] [--work-dir <dir>]`, the same contract as
//    `wrenyard daemon run`.
//  - `--stdio-bridge --connect-to <ipcPath>`, the stdio<->IPC bridge the remote
//    SSH relay invokes on the target host. In this mode nothing but protocol
//    bytes is written to stdout.
const [command, ...args] = process.argv.slice(2)
if (command === '--stdio-bridge') {
  const bridge = parseStdioBridgeArgs(args)
  if (!bridge) {
    process.stderr.write('Usage: daemon --stdio-bridge --connect-to <ipcPath>\n')
    process.exitCode = 2
  } else {
    try {
      process.exitCode = await runStdioBridge(bridge)
    } catch (error) {
      // Fail closed with a bounded stderr diagnostic; stdout stays protocol-only.
      process.stderr.write(
        `daemon --stdio-bridge failed: ${error instanceof Error ? error.message : String(error)}\n`,
      )
      process.exitCode = 1
    }
  }
} else if (command !== 'run') {
  process.stderr.write('Usage: daemon run [--config <path>] [--work-dir <dir>]\n')
  process.exitCode = 2
} else {
  process.exitCode = await runForemanService(args)
}
