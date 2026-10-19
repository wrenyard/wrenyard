import { JsonForemanConfigStore } from './manager.mts'
import { readGlobalTaskSettings, type TaskSettingsLayer, type TasksConfigSettingsInput } from '@wrenyard/task'

/**
 * Persistence boundary for the task settings model. The model itself (layers,
 * normalization and effective-settings resolution) lives in `@wrenyard/task`;
 * this module only owns the config-store reads that produce its input.
 */

/** Read only current routing weights/cap; old auxiliary preference files are inert. */
export function readAuxiliaryRoutingSettings(configPath: string): TaskSettingsLayer | undefined {
  const config = new JsonForemanConfigStore().read(configPath)
  return readGlobalTaskSettings(config?.tasks as TasksConfigSettingsInput | undefined, config)
}
