import { runForemanService } from './server-bootstrap/service.mts'

// The daemon process entry: `run [--config <path>] [--work-dir <dir>]`, the same
// contract as `wrenyard daemon run`.
const [command, ...args] = process.argv.slice(2)
if (command !== 'run') {
  process.stderr.write('Usage: daemon run [--config <path>] [--work-dir <dir>]\n')
  process.exitCode = 2
} else {
  process.exitCode = await runForemanService(args)
}
