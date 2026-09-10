import type { TaskSettingsCapability, TaskSettingsLayer, TaskSettingsPatch } from './shell-contract.js';

type CapabilityRow = {
  builtin: { dispatch: { required_capabilities?: readonly TaskSettingsCapability[] } };
  user_task: TaskSettingsLayer;
  effective: { automatic: { required_capabilities: { value: readonly TaskSettingsCapability[] | null } } };
};

export function builtinRequiresImage(row: CapabilityRow): boolean {
  return row.builtin.dispatch.required_capabilities?.includes('image') === true;
}

/** The daemon's effective value drives the checkbox; task requirements are mandatory. */
export function imageRequiredFromRow(row: CapabilityRow): boolean {
  return builtinRequiresImage(row) || row.effective.automatic.required_capabilities.value?.includes('image') === true;
}

/** Preserve untouched overrides; remove the leaf when a change restores inheritance. */
export function imageCapabilitiesPatch(
  row: CapabilityRow,
  userGlobal: TaskSettingsLayer,
  checked: boolean,
): TaskSettingsPatch {
  if (builtinRequiresImage(row) || checked === imageRequiredFromRow(row)) return {};
  const inherited = userGlobal.automatic?.required_capabilities ?? row.builtin.dispatch.required_capabilities;
  const inheritedImage = inherited?.includes('image') === true;
  return { automatic: { required_capabilities: checked === inheritedImage ? null : checked ? ['image'] : ['text'] } };
}
