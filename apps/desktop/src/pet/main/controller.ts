// ── Pet module public entry ──────────────────────────────────────────
// `pet/main/controller` is the single runtime entry into the Pet module.
// Desktop code outside `src/pet` imports the controller, the TaskGraph window
// factory and the pure Pet helpers from here; Pet DTO text lives in
// `shell-contract`. Nothing outside the module reaches into Pet internals.

export {
  DesktopPetController,
  type DesktopPetControllerOptions,
  type DesktopPetRuntimeHandle,
} from './pet-controller.js';

export {
  DesktopPetRuntime,
  type DesktopPetRuntimeOptions,
  type PetRuntimeStatus,
  type PetVisibility,
} from './runtime.js';

export {
  createTaskGraphWindows,
  type TaskGraphWindowsHandle,
  type TaskGraphWindowOwnerOptions,
} from './windows/taskgraph-windows.js';

export {
  normalizeConfig,
  type AppConfig,
  type EntityVisibilityConfig,
  type HouseConfig,
  type PetSettingsPatchResult,
  type PetSettingsPayload,
  type QuotaProviderEntry,
  type WindowGeometry,
} from './config.js';

export { floorQuotaPercentage } from '../shared/quota-percentage.js';

export * from '../shared/activity-snapshot.js';
export * from '../shared/taskgraph.js';
