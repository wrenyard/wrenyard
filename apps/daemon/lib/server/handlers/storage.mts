import { previewManagedCleanup, runManagedCleanup } from '../../core/storage/cleanup.mts'
import type { ManagedCleanupOptions } from '../../core/storage/cleanup.mts'
import type { ProjectManager } from '../../core/project/manager.mts'
import { readStorageUsage } from '../../core/storage/usage.mts'
import { INVALID_PARAMS, ProtocolError } from '../../protocol/errors.mts'
import type { StorageCleanupCategoryId } from '../../protocol/methods/storage.mts'
import type { CleanupPreviewParams, CleanupRunParams, StorageUsageResult } from '../../protocol/registry.mts'
import type { RpcRouter } from '../rpc-router.mts'

/**
 * Optional overrides for the managed-cleanup surface. The daemon registers the
 * handlers with the resolved workspace context (the real service); tests may
 * inject fakes for the preview/run operations.
 */
export interface StorageCleanupHandlerOptions {
  /** Workspace root used to resolve the project manager for worktree assessment. */
  workspaceRoot?: string
  /** Injected project manager; overrides `workspaceRoot` when present. */
  projectManager?: ProjectManager
  /** Injected preview implementation; defaults to the real managed-cleanup service. */
  previewCleanup?: (params: CleanupPreviewParams) => ReturnType<typeof previewManagedCleanup>
  /** Injected run implementation; defaults to the real managed-cleanup service. */
  runCleanup?: (params: CleanupRunParams) => ReturnType<typeof runManagedCleanup>
}

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
export function registerStorageHandlers(router: RpcRouter, options: StorageCleanupHandlerOptions = {}): void {
  // Pass the workspace/project-manager context through so worktree assessment
  // resolves real worktrees instead of silently protecting every one of them.
  const cleanupOptions = (categories: StorageCleanupCategoryId[] | undefined): ManagedCleanupOptions => ({
    ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
    ...(options.projectManager === undefined ? {} : { projectManager: options.projectManager }),
    ...(categories === undefined ? {} : { categories }),
  })

  const preview = options.previewCleanup
    ?? ((params: CleanupPreviewParams) => previewManagedCleanup(cleanupOptions(params.categories)))
  const run = options.runCleanup
    ?? ((params: CleanupRunParams) => runManagedCleanup({ ...cleanupOptions(params.categories), trigger: 'rpc' }))

  router.register('storage.usage', (params, _message, context) => {
    requireIpc(context, 'storage.usage', 'storage_usage_forbidden')
    return readStorageUsage(params.refresh === true) satisfies StorageUsageResult
  })

  router.register('storage.cleanup.preview', async (params, _message, context) => {
    requireIpc(context, 'storage.cleanup.preview', 'storage_cleanup_forbidden')
    return preview(params)
  })

  router.register('storage.cleanup.run', async (params, _message, context) => {
    requireIpc(context, 'storage.cleanup.run', 'storage_cleanup_forbidden')
    return run(params)
  })
}
