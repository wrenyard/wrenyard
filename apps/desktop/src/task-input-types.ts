import type { TaskSettingsCapability, TaskSettingsLayer, TaskSettingsPatch } from './shell-contract.js';

export type TaskInputTypeValue = 'inherit' | 'text' | 'image';

function selectionForOverride(override: readonly TaskSettingsCapability[] | null | undefined): TaskInputTypeValue {
  if (override == null) return 'inherit';
  return override.includes('image') ? 'image' : 'text';
}

/** Display the editable layer, while the form separately shows effective requirements. */
export function inputTypeFromRow(row: { user_task: TaskSettingsLayer }): TaskInputTypeValue {
  return selectionForOverride(row.user_task.automatic?.required_capabilities);
}

/** Patch only a changed override; an untouched inherited or legacy array stays untouched. */
export function inputTypesPatch(
  override: readonly TaskSettingsCapability[] | null | undefined,
  selected: TaskInputTypeValue,
): TaskSettingsPatch {
  if (selectionForOverride(override) === selected) return {};
  const required_capabilities = selected === 'inherit' ? null : selected === 'image' ? ['text', 'image'] as const : ['text'] as const;
  return { automatic: { required_capabilities } };
}
