// ── Shell IPC boundary validation ────────────────────────────────────
// All DTO-shape/bounds validation used by the shell IPC handlers. Desktop
// validates the public DTO shape and bounds only; it never merges or re-derives
// daemon-owned settings, so a validated request is always passed through
// unchanged. Grouped here so each domain IPC module shares one implementation.

import { REASONING_EFFORTS, type ReasoningEffort } from '@wrenyard/models';
import type {
  ExecEventsRequest,
  ExecStartRequest,
  RuntimeAliasPutRequest,
  RuntimeAliasRemoveRequest,
  TaskRoutingTestParams,
  TaskSettingsAutomaticDispatch,
  TaskSettingsSaveRequest,
} from '../../shell-contract.js';

export const TASK_SETTINGS_PATCH_KEYS = new Set(['mode', 'explicit_runtime', 'timeout_ms', 'max_auto_output_usd_per_million', 'automatic']);
export const TASK_SETTINGS_AUTOMATIC_KEYS = new Set([
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
]);
export const TASK_SETTINGS_INTELLIGENCE_VALUES = new Set(['low', 'mid', 'high', 'premium']);
export const TASK_SETTINGS_CAPABILITY_VALUES = new Set(['text', 'image']);
export const RUNTIME_ALIAS_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const RUNTIME_ALIAS_REVISION_MAX = 512;
export const RUNTIME_ALIAS_TARGET_MAX = 512;
export const TASK_SETTINGS_STRING_MAX = 512;
export const TASK_SETTINGS_STRING_ARRAY_MAX = 64;
export const TASK_SETTINGS_CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

export function isBoundedPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function boundedOptionalProject(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value || value.length > 4_096) throw new Error('项目参数无效');
  return value;
}

export function isFinitePositiveNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

export function isBoundedRevision(value: unknown): value is string {
  return isBoundedString(value, RUNTIME_ALIAS_REVISION_MAX);
}

export function validateExplicitReferenceValue(explicitReference: unknown): void {
  if (explicitReference === undefined || explicitReference === null) return;
  if (!isBoundedPlainObject(explicitReference)) throw new Error('显式运行时引用无效');
  const kind = explicitReference.kind;
  if (kind === 'alias') {
    for (const field of Object.keys(explicitReference)) {
      if (field !== 'kind' && field !== 'name') throw new Error('显式运行时引用无效');
    }
    const name = explicitReference.name;
    if (typeof name !== 'string' || !RUNTIME_ALIAS_NAME.test(name)) throw new Error('显式运行时引用无效');
    return;
  }
  if (kind === 'target') {
    for (const field of Object.keys(explicitReference)) {
      if (field !== 'kind' && field !== 'target') throw new Error('显式运行时引用无效');
    }
    const target = explicitReference.target;
    if (typeof target !== 'string' || !target || target.length > TASK_SETTINGS_STRING_MAX || TASK_SETTINGS_CONTROL_CHARS.test(target)) {
      throw new Error('显式运行时引用无效');
    }
    return;
  }
  throw new Error('显式运行时引用无效');
}

export function validateAutomaticDispatch(automatic: unknown, allowFieldReset = false): void {
  if (automatic === undefined || automatic === null) return;
  if (!isBoundedPlainObject(automatic)) throw new Error('自动约束无效');
  for (const key of Object.keys(automatic)) {
    if (!TASK_SETTINGS_AUTOMATIC_KEYS.has(key)) throw new Error('自动约束无效');
  }
  for (const field of ['expected_tps', 'minimum_tps', 'max_output_usd_per_million'] as const) {
    const value = automatic[field];
    if (allowFieldReset && value === null) continue;
    if (value !== undefined && !isFinitePositiveNumber(value)) throw new Error('自动约束无效');
  }
  for (const field of ['intelligence_min', 'intelligence_expected'] as const) {
    const value = automatic[field];
    if (allowFieldReset && value === null) continue;
    if (value !== undefined && (typeof value !== 'string' || !TASK_SETTINGS_INTELLIGENCE_VALUES.has(value))) {
      throw new Error('自动约束无效');
    }
  }
  const requiresWebSearch = automatic.requires_web_search;
  if (requiresWebSearch !== undefined && !(allowFieldReset && requiresWebSearch === null) && typeof requiresWebSearch !== 'boolean') {
    throw new Error('自动约束无效');
  }
  const requiredCapabilities = automatic.required_capabilities;
  if (requiredCapabilities !== undefined) {
    if (allowFieldReset && requiredCapabilities === null) {
      // A null nested patch deletes only this field from the current layer.
    } else {
    if (!Array.isArray(requiredCapabilities) || requiredCapabilities.length > 16) throw new Error('自动约束无效');
    for (const value of requiredCapabilities) {
      if (typeof value !== 'string' || !TASK_SETTINGS_CAPABILITY_VALUES.has(value)) throw new Error('自动约束无效');
    }
    }
  }
  for (const field of ['exclude_model_ids', 'exclude_profile_ids', 'exclude_client_ids', 'exclude_provider_ids'] as const) {
    const value = automatic[field];
    if (value !== undefined) {
      if (allowFieldReset && value === null) continue;
      if (!Array.isArray(value) || value.length > TASK_SETTINGS_STRING_ARRAY_MAX) throw new Error('自动约束无效');
      for (const item of value) {
        if (typeof item !== 'string' || !item || item.length > TASK_SETTINGS_STRING_MAX) throw new Error('自动约束无效');
      }
    }
  }
}

/**
 * IPC-boundary validation for task.settings.save. Desktop validates the public
 * DTO shape and bounds only; it never merges settings, so the validated request
 * is passed through to main unchanged.
 */
export function validateTaskSettingsSaveRequest(value: unknown): TaskSettingsSaveRequest {
  if (!isBoundedPlainObject(value)) throw new Error('任务设置请求无效');
  const scope = value.scope;
  if (scope !== 'global' && scope !== 'task') throw new Error('任务设置作用域无效');
  const expectedRevision = value.expected_revision;
  if (typeof expectedRevision !== 'string' || !expectedRevision || expectedRevision.length > 512) {
    throw new Error('任务设置版本基线无效');
  }
  const taskId = value.task_id;
  if (taskId !== undefined && taskId !== null) {
    if (typeof taskId !== 'string' || !taskId || taskId.length > 512) throw new Error('任务 id 无效');
  }
  if (scope === 'task' && (typeof taskId !== 'string' || !taskId)) throw new Error('任务作用域必须携带 task_id');
  const project = boundedOptionalProject(value.project);
  const patch = value.patch;
  if (!isBoundedPlainObject(patch)) throw new Error('任务设置内容无效');
  for (const key of Object.keys(patch)) {
    if (!TASK_SETTINGS_PATCH_KEYS.has(key)) throw new Error('任务设置内容无效');
  }
  const autoOutputCap = patch.max_auto_output_usd_per_million;
  if (autoOutputCap !== undefined) {
    // Global-only auto-dispatch reference output cap; null clears, 0 is valid.
    // The nested per-task automatic max_output_usd_per_million stays strictly positive.
    if (scope !== 'global') throw new Error('自动派发参考输出单价上限仅支持全局作用域');
    if (autoOutputCap !== null && (typeof autoOutputCap !== 'number' || !Number.isFinite(autoOutputCap) || autoOutputCap < 0)) {
      throw new Error('自动派发参考输出单价上限无效');
    }
  }
  const mode = patch.mode;
  if (mode !== undefined && mode !== null && mode !== 'automatic' && mode !== 'explicit') throw new Error('运行时模式无效');
  validateExplicitReferenceValue(patch.explicit_runtime);
  const timeoutMs = patch.timeout_ms;
  if (timeoutMs !== undefined && timeoutMs !== null) {
    if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('超时设置无效');
  }
  validateAutomaticDispatch(patch.automatic, true);
  const request: TaskSettingsSaveRequest = {
    scope,
    expected_revision: expectedRevision,
    patch: patch as TaskSettingsSaveRequest['patch'],
  };
  if (taskId !== undefined && taskId !== null) request.task_id = taskId;
  if (project !== undefined) request.project = project;
  return request;
}

/**
 * IPC-boundary validation for runtime.alias.put. Desktop validates the public
 * DTO shape and bounds only; the alias store itself stays daemon-owned.
 */
export function validateRuntimeAliasPutRequest(value: unknown): RuntimeAliasPutRequest {
  if (!isBoundedPlainObject(value)) throw new Error('运行时别名请求无效');
  const expectedRevision = value.expected_revision;
  if (!isBoundedRevision(expectedRevision)) throw new Error('运行时别名版本基线无效');
  const name = value.name;
  if (typeof name !== 'string' || !RUNTIME_ALIAS_NAME.test(name)) throw new Error('运行时别名格式无效');
  const target = value.target;
  if (typeof target !== 'string' || !target || target.length > RUNTIME_ALIAS_TARGET_MAX || TASK_SETTINGS_CONTROL_CHARS.test(target)) {
    throw new Error('运行时目标无效');
  }
  return { expected_revision: expectedRevision, name, target };
}

/** IPC-boundary validation for runtime.alias.remove; CAS on the store revision. */
export function validateRuntimeAliasRemoveRequest(value: unknown): RuntimeAliasRemoveRequest {
  if (!isBoundedPlainObject(value)) throw new Error('运行时别名请求无效');
  const expectedRevision = value.expected_revision;
  if (!isBoundedRevision(expectedRevision)) throw new Error('运行时别名版本基线无效');
  const name = value.name;
  if (typeof name !== 'string' || !RUNTIME_ALIAS_NAME.test(name)) throw new Error('运行时别名格式无效');
  return { expected_revision: expectedRevision, name };
}

/**
 * IPC-boundary validation for task.settings.routingTest. Desktop validates the
 * typed form DTO shape and bounds only; the daemon owns evaluation, scoring,
 * and ranking, so the validated request is passed through unchanged. Unknown
 * automatic keys are rejected — an imported payload must round-trip verbatim.
 */
export function validateTaskRoutingTestParams(value: unknown): TaskRoutingTestParams {
  if (!isBoundedPlainObject(value)) throw new Error('路由测试请求无效');
  const automatic = value.automatic;
  if (!isBoundedPlainObject(automatic)) throw new Error('自动约束无效');
  validateAutomaticDispatch(automatic);
  const timeoutMs = value.timeout_ms;
  if (timeoutMs !== undefined) {
    if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('超时设置无效');
  }
  const params: TaskRoutingTestParams = {
    automatic: { ...automatic } as TaskSettingsAutomaticDispatch,
  };
  if (timeoutMs !== undefined) params.timeout_ms = timeoutMs;
  return params;
}

export const EXEC_ID_MAX = 200;
export const EXEC_FEATURE_MAX = 32;
export const EXEC_FEATURE_ID_MAX = 120;
export const EXEC_PROMPT_MAX = 4_000_000;
export const EXEC_CWD_MAX = 4_096;
export const EXEC_MODEL_MAX = 512;
export const EXEC_PROVIDER_MAX = 200;
export const EXEC_CLIENT_MAX = 120;
export const EXEC_SESSION_MAX = 1_024;
/** Legal public reasoning-effort levels (including `none`); the shared ladder is the authority. */
export const EXEC_REASONING_EFFORT_VALUES = new Set<string>(REASONING_EFFORTS);
export const EXEC_MODE_VALUES = new Set(['native', 'gateway']);

export function isBoundedExecId(value: unknown): value is string {
  return isBoundedString(value, EXEC_ID_MAX);
}

/**
 * IPC-boundary validation for one raw prompt execution request. Desktop only
 * checks DTO shape and bounds; the daemon owns client/model resolution, so an
 * unknown client or feature id is rejected there, not guessed here. No field
 * can smuggle a process environment or credential.
 */
export function validateExecStartRequest(value: unknown): ExecStartRequest {
  if (!isBoundedPlainObject(value)) throw new Error('执行请求无效');
  const client = value.client;
  if (typeof client !== 'string' || !client.trim() || client.length > EXEC_CLIENT_MAX) throw new Error('执行客户端无效');
  const model = value.model;
  if (typeof model !== 'string' || !model.trim() || model.length > EXEC_MODEL_MAX) throw new Error('执行模型无效');
  const prompt = value.prompt;
  if (typeof prompt !== 'string' || !prompt || prompt.length > EXEC_PROMPT_MAX) throw new Error('执行提示词无效');
  const cwd = value.cwd;
  if (typeof cwd !== 'string' || !cwd.trim() || cwd.length > EXEC_CWD_MAX || TASK_SETTINGS_CONTROL_CHARS.test(cwd)) {
    throw new Error('执行工作目录无效');
  }
  // The wire field is the required public reasoning effort (the exec protocol
  // was renamed away from `thinking`); `none` is a valid level.
  const reasoningEffort = value.reasoningEffort;
  if (typeof reasoningEffort !== 'string' || !EXEC_REASONING_EFFORT_VALUES.has(reasoningEffort)) {
    throw new Error('推理强度无效');
  }
  if (value.thinking !== undefined) throw new Error('推理强度无效');
  const request: ExecStartRequest = { client, model, prompt, cwd, reasoningEffort: reasoningEffort as ReasoningEffort };
  if (value.provider !== undefined) {
    if (typeof value.provider !== 'string' || !value.provider.trim() || value.provider.length > EXEC_PROVIDER_MAX) {
      throw new Error('执行 provider 无效');
    }
    request.provider = value.provider;
  }
  if (value.mode !== undefined) {
    if (typeof value.mode !== 'string' || !EXEC_MODE_VALUES.has(value.mode)) throw new Error('执行模式无效');
    request.mode = value.mode as 'native' | 'gateway';
  }
  if (value.resumeSessionId !== undefined) {
    if (typeof value.resumeSessionId !== 'string' || !value.resumeSessionId.trim() || value.resumeSessionId.length > EXEC_SESSION_MAX) {
      throw new Error('恢复会话 id 无效');
    }
    request.resumeSessionId = value.resumeSessionId;
  }
  if (value.features !== undefined) {
    const features = value.features;
    if (!Array.isArray(features) || features.length > EXEC_FEATURE_MAX) throw new Error('执行特性列表无效');
    for (const feature of features) {
      if (typeof feature !== 'string' || !feature.trim() || feature.length > EXEC_FEATURE_ID_MAX) {
        throw new Error('执行特性 id 无效');
      }
    }
    request.features = features as string[];
  }
  return request;
}

/** IPC-boundary validation for one exec.events page request. */
export function validateExecEventsRequest(value: unknown): ExecEventsRequest {
  if (!isBoundedPlainObject(value)) throw new Error('执行事件请求无效');
  const id = value.id;
  if (!isBoundedExecId(id)) throw new Error('执行 id 无效');
  const request: ExecEventsRequest = { id };
  if (value.afterSeq !== undefined) {
    const afterSeq = value.afterSeq;
    if (typeof afterSeq !== 'number' || !Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error('执行事件游标无效');
    request.afterSeq = afterSeq;
  }
  return request;
}

/** IPC-boundary validation for the Windows application-menu popup anchor. */
export function validateAppMenuPosition(value: unknown): { x: number; y: number } | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isBoundedPlainObject(value)) throw new Error('菜单位置无效');
  const x = value.x;
  const y = value.y;
  if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) {
    throw new Error('菜单位置无效');
  }
  return { x, y };
}
