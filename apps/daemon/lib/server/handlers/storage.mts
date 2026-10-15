import { readStorageUsage } from '../../core/storage/usage.mts'
import { INVALID_PARAMS, ProtocolError } from '../../protocol/errors.mts'
import type { StorageUsageResult } from '../../protocol/registry.mts'
import type { RpcRouter } from '../rpc-router.mts'

/**
 * Register the read-only `storage.usage` surface.
 *
 * The method reports the daemon's own data-directory footprint and the device
 * it runs on, so it exposes local absolute paths and is IPC-only — the same
 * owner-only guard `workspace.switch` and `daemon.shutdown` use. The read-only
 * scan runs in the background and is never awaited here.
 */
export function registerStorageHandlers(router: RpcRouter): void {
  router.register('storage.usage', (params, _message, context) => {
    const transport = context && typeof context === 'object' && 'transport' in context
      ? (context as { transport?: unknown }).transport
      : undefined
    if (transport !== 'ipc') {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: 'storage.usage is only available over IPC' },
        { code: 'storage_usage_forbidden', statusCode: 403, transport: transport ?? 'unknown' },
      )
    }
    return readStorageUsage(params.refresh === true) satisfies StorageUsageResult
  })
}
