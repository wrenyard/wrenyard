import { watch, type FSWatcher } from 'node:fs'
import { resolve } from 'node:path'
import { invalidateProjectCache } from '../core/project/loader.mts'
import { markDirty } from './definition-registry.mts'

export interface HotReloadHandle {
  close: () => void
}

export function startHotReload(workspaceRoot: string): HotReloadHandle {
  const root = resolve(workspaceRoot)
  const watcher = watch(root, { recursive: true }, (_eventType, filename) => {
    if (!filename) return
    const fullPath = resolve(root, filename.toString())

    if (fullPath.endsWith('.task.ts')) {
      markDirty(root)
      return
    }

    // Project-level configuration changes
    const name = filename.toString()
    if (name.endsWith('.fmproj')) {
      process.stderr.write(`[foreman] project config changed: ${name} — invalidating project cache\n`)
      invalidateProjectCache()
      return
    }
  }) as FSWatcher

  return {
    close: () => watcher.close(),
  }
}
