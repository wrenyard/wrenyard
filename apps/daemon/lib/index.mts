/**
 * Public surface of the Wrenyard daemon package.
 *
 * The daemon owns task/execution lifecycle, business persistence and the
 * product IPC server. The CLI application consumes the daemon through the
 * subpath exports declared in package.json rather than reaching into `lib/`.
 */
export { ForemanDaemon, startForemanDaemon } from './daemon/daemon.mts'
export type { ForemanDaemonOptions, ForemanDaemonDeps, RunningForemanDaemon } from './daemon/daemon.mts'
export { runForemanService } from './server-bootstrap/service.mts'
export { connectIpcForemanClient } from './control/ipc-client.mts'
export type { ConnectIpcForemanClientOptions } from './control/ipc-client.mts'
export { ForemanClient } from './control/client.mts'
export { resolveForemanServiceIpcPath } from './control/ipc-server.mts'
