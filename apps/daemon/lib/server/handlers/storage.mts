import { previewManagedCleanup, runManagedCleanup } from '../../core/storage/cleanup.mts'
import { readStorageUsage } from '../../core/storage/usage.mts'
import { INVALID_PARAMS, ProtocolError } from '../../protocol/errors.mts'
import type { StorageUsageResult } from '../../protocol/registry.mts'
import type { RpcRouter } from '../rpc-router.mts'

function requireIpc(context: unknown, method: string, code: string): void {
  const transport = context && typeof context === 'object' && 'transport' in context
    ? (context as { transport?: unknown }).transport
    : undefined
  if (transport !== 'ipc') {
    throw new ProtocolError(
      { code: INVALID_PARAMS.code, message: `${method} is only available over IPC` },
      { code, statusCode: 403, transport: transport ?? 'unknown' },
    )
  }
}

/**
 * Register the read-only `storage.usage` surface and the managed-cleanup
 * surface (`storage.cleanup.preview`, `storage.cleanup.run`).
 *
 * All three methods report or act on the daemon's own data directory, so they
 * expose local absolute paths and are IPC-only — the same owner-only guard
 * `workspace.switch` and `daemon.shutdown` use. `storage.usage` answers from a
 * background scan; the cleanup preview scans fresh, and the run is awaited so
 * the caller observes the exact removals it caused.
 */
export function registerStorageHandlers(router: RpcRouter): void {
  router.register('storage.usage', (params, _message, context) => {
    requireIpc(context, 'storage.usage', 'storage_usage_forbidden')
    return readStorageUsage(params.refresh === true) satisfies StorageUsageResult
  })

  router.register('storage.cleanup.preview', async (params, _message, context) => {
    requireIpc(context, 'storage.cleanup.preview', 'storage_cleanup_forbidden')
    return previewManagedCleanup({ categories: params.categories })
  })

  router.register('storage.cleanup.run', async (params, _message, context) => {
    requireIpc(context, 'storage.cleanup.run', 'storage_cleanup_forbidden')
    return runManagedCleanup({ categories: params.categories, trigger: 'rpc' })
  })
}
