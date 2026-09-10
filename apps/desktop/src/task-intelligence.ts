import type {
  TaskSettingsAutomaticPatch,
  TaskSettingsIntelligence,
  TaskSettingsLayer,
  TaskSettingsPatch,
} from './shell-contract.js';

/** Editable intelligence tier selection: inherit means no per-task override. */
export type TaskIntelligenceValue = 'inherit' | 'low' | 'mid' | 'high' | 'premium';

/** The two optional intelligence selectors as a single unit. */
export type TaskIntelligenceSelections = {
  min: TaskIntelligenceValue;
  expected: TaskIntelligenceValue;
};

/** Current user_task intelligence override, with the same optional/null shape as the wire layer. */
export type TaskIntelligenceOverride = {
  intelligence_min?: TaskSettingsIntelligence | null;
  intelligence_expected?: TaskSettingsIntelligence | null;
} | null | undefined;

function selectionForIntelligence(override: TaskSettingsIntelligence | null | undefined): TaskIntelligenceValue {
  return override == null ? 'inherit' : override;
}

/** Display the editable layer, while the form separately shows effective tiers. */
export function intelligenceSelectionFromRow(row: { user_task: TaskSettingsLayer }): TaskIntelligenceSelections {
  const automatic = row.user_task.automatic;
  return {
    min: selectionForIntelligence(automatic?.intelligence_min),
    expected: selectionForIntelligence(automatic?.intelligence_expected),
  };
}

/** Patch only changed tier leaves. An untouched inherit emits no patch even when
 *  the effective value is populated (comparison is against the user_task override,
 *  not the effective value), and re-selecting inherit emits null to clear that one
 *  leaf. Independent min/expected changes share a single automatic object. */
export function intelligencePatch(current: TaskIntelligenceOverride, selected: TaskIntelligenceSelections): TaskSettingsPatch {
  const automatic: TaskSettingsAutomaticPatch = {};
  const minCurrent = selectionForIntelligence(current?.intelligence_min);
  if (minCurrent !== selected.min) {
    automatic.intelligence_min = selected.min === 'inherit' ? null : selected.min;
  }
  const expectedCurrent = selectionForIntelligence(current?.intelligence_expected);
  if (expectedCurrent !== selected.expected) {
    automatic.intelligence_expected = selected.expected === 'inherit' ? null : selected.expected;
  }
  if (Object.keys(automatic).length === 0) return {};
  return { automatic };
}
