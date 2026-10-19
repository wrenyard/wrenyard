import { JsonForemanConfigStore } from './manager.mts'
import { readGlobalTaskSettings, type TaskSettingsLayer, type TasksConfigSettingsInput } from '@wrenyard/task'

/**
 * Persistence boundary for the task settings model. The model itself (layers,
 * normalization and effective-settings resolution) lives in `@wrenyard/task`;
 * this module only owns the config-store reads that produce its input.
 */

/** Persisted keys of the removed explicit runtime selection feature. */
const LEGACY_SELECTION_KEYS = ['selectionMode', 'selection_mode', 'explicitRuntime', 'explicit_runtime'] as const

/**
 * Runtime selection is automatic only, so a persisted layer may still carry the
 * removed explicit-selection keys. They are ignored on read and never migrated
 * or rewritten; this reports one line per affected layer, not one per key.
 */
function warnOnLegacySelectionKeys(raw: unknown, scope: string): void {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return
  const record = raw as Record<string, unknown>
  if (LEGACY_SELECTION_KEYS.some((key) => record[key] !== undefined)) {
    console.warn(`config: ignoring legacy explicit task runtime settings at ${scope}; runtime selection is automatic`)
  }
}

/** Read only current routing weights/cap; old auxiliary preference files are inert. */
export function readAuxiliaryRoutingSettings(configPath: string): TaskSettingsLayer | undefined {
  const config = new JsonForemanConfigStore().read(configPath)
  const settings = (config?.tasks as TasksConfigSettingsInput | undefined)?.settings
  warnOnLegacySelectionKeys(settings?.global, 'tasks.settings.global')
  for (const [identity, layer] of Object.entries(settings?.byTask ?? {})) {
    warnOnLegacySelectionKeys(layer, `tasks.settings.byTask[${identity}]`)
  }
  return readGlobalTaskSettings(config?.tasks as TasksConfigSettingsInput | undefined, config)
}
