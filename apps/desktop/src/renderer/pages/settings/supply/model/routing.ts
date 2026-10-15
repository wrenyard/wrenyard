import type {
  TaskRoutingTestParams,
  TaskRoutingTestRow,
  TaskRoutingTestTask,
  TaskSettingsAutomaticDispatch,
} from '@/shell-contract';

/**
 * Pure routing-test form logic for the Model Supply page.
 *
 * This module only serializes the typed form into a `TaskRoutingTestParams`
 * request, copies an imported task's raw automatic configuration into form
 * state, and formats daemon-provided numbers for display. It never computes
 * routing, ranking or scores: every number shown comes verbatim from the
 * backend response. No React or DOM access lives here.
 */

/** Exact automatic-dispatch field keys, in a stable form-control order. */
export const ROUTING_TEST_AUTOMATIC_KEYS = [
  'expected_tps',
  'minimum_tps',
  'intelligence_min',
  'intelligence_expected',
  'max_output_usd_per_million',
  'required_capabilities',
  'requires_web_search',
  'exclude_model_ids',
  'exclude_profile_ids',
  'exclude_client_ids',
  'exclude_provider_ids',
] as const;

/** Intelligence tiers ordered weakest-first; the form enforces min ≤ expected. */
export const INTELLIGENCE_TIERS = ['low', 'mid', 'high', 'premium'] as const;

/** Localized labels for the intelligence tier options. */
export const INTELLIGENCE_LABELS: Record<string, string> = {
  low: '低',
  mid: '中',
  high: '高',
  premium: '旗舰',
};

/**
 * Editable form state. Every field mirrors the automatic constraint it
 * serializes; empty strings are "unset" and are omitted from the request.
 * Imported exclusions are held verbatim so an imported capability set or
 * exclusion list is never silently lost.
 */
export interface RoutingTestFormState {
  /** Decimal text for expected/minimum TPS and the reference output cap. */
  expectedTps: string;
  minimumTps: string;
  maxOutputUsdPerMillion: string;
  /** Selected intelligence requirement, or '' when unset. */
  intelligenceMin: string;
  intelligenceExpected: string;
  /** Requires image input capability (`required_capabilities` contains image). */
  requireImage: boolean;
  /** Requires web search (`requires_web_search`). */
  requireWebSearch: boolean;
  /** Exact model exclusion IDs; imported unknowns are held verbatim. */
  excludeModelIds: string[];
  /** Exact provider exclusion IDs; imported unknowns are held verbatim. */
  excludeProviderIds: string[];
  /** Imported profile exclusions, held verbatim; not edited by the form UI. */
  excludeProfileIds: string[];
  /** Imported client exclusions, held verbatim; not edited by the form UI. */
  excludeClientIds: string[];
  /** Always requested when this form is submitted. */
  requireText: boolean;
  /** Optional request timeout in milliseconds, or '' when unset. */
  timeoutMs: string;
}

/** Blank form defaults: no minimum/recommended mid, no cap, text-only. */
export function defaultRoutingTestForm(): RoutingTestFormState {
  return {
    expectedTps: '',
    minimumTps: '',
    maxOutputUsdPerMillion: '',
    intelligenceMin: '',
    intelligenceExpected: 'mid',
    requireImage: false,
    requireWebSearch: false,
    excludeModelIds: [],
    excludeProviderIds: [],
    excludeProfileIds: [],
    excludeClientIds: [],
    requireText: false,
    timeoutMs: '',
  };
}

function parsePositiveNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) throw new Error('请输入大于 0 的数值');
  return value;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Serializes the editable form into the exact typed request. Unset fields are
 * omitted rather than sent as null/zero; imported exclusions and capability
 * requirements are preserved verbatim.
 */
export function serializeRoutingTestRequest(form: RoutingTestFormState): TaskRoutingTestParams {
  const automatic: Partial<TaskSettingsAutomaticDispatch> = {};
  const expectedTps = parsePositiveNumber(form.expectedTps);
  if (expectedTps !== null) automatic.expected_tps = expectedTps;
  const minimumTps = parsePositiveNumber(form.minimumTps);
  if (minimumTps !== null) automatic.minimum_tps = minimumTps;
  if (form.intelligenceMin) automatic.intelligence_min = form.intelligenceMin as TaskSettingsAutomaticDispatch['intelligence_min'];
  if (form.intelligenceExpected) automatic.intelligence_expected = form.intelligenceExpected as TaskSettingsAutomaticDispatch['intelligence_expected'];
  const tiers: readonly string[] = INTELLIGENCE_TIERS;
  if (form.intelligenceMin && tiers.indexOf(form.intelligenceExpected) < tiers.indexOf(form.intelligenceMin)) {
    throw new Error('推荐智能不能低于最低智能');
  }
  if (expectedTps !== null && minimumTps !== null && expectedTps < minimumTps) throw new Error('期望 TPS 不能低于最低 TPS');
  const cap = parsePositiveNumber(form.maxOutputUsdPerMillion);
  if (cap !== null) automatic.max_output_usd_per_million = cap;

  const capabilities: Array<'text' | 'image'> = [];
  if (form.requireText) capabilities.push('text');
  if (form.requireImage) capabilities.push('image');
  if (capabilities.length > 0) automatic.required_capabilities = capabilities;
  if (form.requireWebSearch) automatic.requires_web_search = true;

  const excludeModelIds = unique(form.excludeModelIds);
  if (excludeModelIds.length > 0) automatic.exclude_model_ids = excludeModelIds;
  const excludeProviderIds = unique(form.excludeProviderIds);
  if (excludeProviderIds.length > 0) automatic.exclude_provider_ids = excludeProviderIds;
  const excludeProfileIds = unique(form.excludeProfileIds);
  if (excludeProfileIds.length > 0) automatic.exclude_profile_ids = excludeProfileIds;
  const excludeClientIds = unique(form.excludeClientIds);
  if (excludeClientIds.length > 0) automatic.exclude_client_ids = excludeClientIds;

  const params: TaskRoutingTestParams = { automatic: automatic as TaskSettingsAutomaticDispatch };
  const timeoutMs = Number(form.timeoutMs.trim());
  if (form.timeoutMs.trim().length > 0 && Number.isSafeInteger(timeoutMs) && timeoutMs > 0) {
    params.timeout_ms = timeoutMs;
  }
  return params;
}

/**
 * Copies a task's effective automatic configuration and timeout into editable
 * form state. The daemon resolves the user's global and per-task layers before
 * this point, so a locally excluded provider arrives already selected.
 * Imported capability requirements and exclusions are preserved: the form only
 * surfaces image/search checkboxes plus model/provider exclusions, so
 * profile/client exclusions are carried through unchanged.
 */
export function formFromTask(task: TaskRoutingTestTask): RoutingTestFormState {
  const automatic = task.automatic;
  const form = defaultRoutingTestForm();
  if (automatic.expected_tps !== undefined) form.expectedTps = String(automatic.expected_tps);
  if (automatic.minimum_tps !== undefined) form.minimumTps = String(automatic.minimum_tps);
  if (automatic.max_output_usd_per_million !== undefined) {
    form.maxOutputUsdPerMillion = String(automatic.max_output_usd_per_million);
  }
  form.intelligenceMin = automatic.intelligence_min ?? '';
  form.intelligenceExpected = automatic.intelligence_expected ?? (['high', 'premium'].includes(form.intelligenceMin) ? form.intelligenceMin : 'mid');
  const capabilities = automatic.required_capabilities ?? [];
  form.requireText = capabilities.includes('text');
  form.requireImage = capabilities.includes('image');
  form.requireWebSearch = automatic.requires_web_search === true;
  form.excludeModelIds = [...(automatic.exclude_model_ids ?? [])];
  form.excludeProviderIds = [...(automatic.exclude_provider_ids ?? [])];
  form.excludeProfileIds = [...(automatic.exclude_profile_ids ?? [])];
  form.excludeClientIds = [...(automatic.exclude_client_ids ?? [])];
  if (task.timeout_ms !== undefined) form.timeoutMs = String(task.timeout_ms);
  return form;
}

/** Display label for an imported task, marking project tasks with their scope. */
export function routingTestTaskLabel(task: TaskRoutingTestTask): string {
  return task.project !== undefined && task.project.length > 0
    ? `${task.display_name} · ${task.project === 'gol' ? 'GOL' : task.project}`
    : task.display_name;
}

export function routingTestErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
  return String(error);
}

/** Show at most this many fractional digits for a daemon-provided score. */
const FRACTION_DIGITS = 4;

/** Format one backend-provided scoring factor; null/unknown renders as an em dash. */
export function formatFactor(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: FRACTION_DIGITS }).format(value);
}

function formatTps(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
}

function formatRank(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return String(value);
}

/** One rendered cell of a daemon routing-test row, by column id. */
export function routingTestRowCell(row: TaskRoutingTestRow, column: string): string {
  switch (column) {
    case 'rank': return formatRank(row.rank);
    case 'provider': return row.provider_name;
    case 'model': return row.model_name;
    case 'tps': return formatTps(row.effective_tps);
    case 'price': return formatFactor(row.price_score);
    case 'speed': return formatFactor(row.speed_score);
    case 'quota': return formatFactor(row.quota_score);
    case 'intelligence': return formatFactor(row.intelligence_score);
    case 'score': return formatFactor(row.score);
    case 'reason': return row.reason ?? '';
    default: return '';
  }
}
