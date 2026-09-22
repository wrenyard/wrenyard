import type {
  TaskRunSnapshot,
  TaskRunSpeedEvidence,
  TaskRunUsage,
} from '@wrenyard/protocol/session';

/**
 * Project CORE's frozen snake_case `TaskRunOutputResult` metadata onto the
 * product `TaskRunSnapshot` DTO.
 *
 * Only the fields the conversation surface actually renders are projected, and
 * every optional field is omitted rather than defaulted: an unknown token count
 * stays absent instead of becoming zero, and paired Catalog display labels
 * travel only when the server row carries both.
 */
export function parseTaskRunSnapshot(value: unknown): TaskRunSnapshot | null {
  const record = asRecord(value);
  if (!record) return null;
  const taskRunId = readTaskRunId(record.task_run_id);
  const taskId = readTaskId(record.task) ?? readTaskId(record.task_id);
  if (taskRunId === null || taskId === null) return null;

  const sourceValue = record.source;
  const statusValue = record.status;
  const resolvedRecord = asRecord(record.resolved);
  const speedRecord = resolvedRecord ? resolvedRecord.speed : record['resolved.speed'];
  const speed = parseTaskRunSpeed(speedRecord);
  const usage = parseTaskRunUsage(record.usage);
  if (!usage) return null;
  const resolvedClient = readString(resolvedRecord?.client) ?? readString(record.resolved_client);
  const resolvedProvider = readString(resolvedRecord?.provider) ?? readString(record.resolved_provider);
  const resolvedProfile = readString(resolvedRecord?.profile) ?? readString(record.resolved_profile);
  const resolvedModel = readString(resolvedRecord?.model) ?? readString(record.resolved_model);
  const resolvedModelId = readString(resolvedRecord?.model_id) ?? readString(record.resolved_model_id);
  const providerDisplayName = readString(record.provider_display_name);
  const modelDisplayName = readString(record.model_display_name);
  // Paired Catalog display labels travel only when the server row carries both
  // as nonempty strings; they are never derived from resolved identities and
  // one is never copied when its sibling is missing.
  const displayLabels =
    providerDisplayName !== null &&
    providerDisplayName.length > 0 &&
    modelDisplayName !== null &&
    modelDisplayName.length > 0
      ? {
          resolvedProviderDisplayName: providerDisplayName,
          resolvedModelDisplayName: modelDisplayName,
        }
      : null;

  return {
    taskRunId,
    taskId,
    ...(typeof record.task_name === 'string' && record.task_name.length > 0 ? { taskName: record.task_name } : {}),
    ...(isTaskSource(sourceValue) ? { source: sourceValue } : {}),
    ...(isTaskRunStatus(statusValue) ? { status: statusValue } : {}),
    ...(readString(record.started_at) !== null ? { startedAt: record.started_at as string } : {}),
    ...(readString(record.finished_at) !== null ? { finishedAt: record.finished_at as string } : {}),
    ...(readString(record.project) !== null ? { project: record.project as string } : {}),
    ...(resolvedClient !== null ? { resolvedClient } : {}),
    ...(resolvedProvider !== null ? { resolvedProvider } : {}),
    ...(resolvedProfile !== null ? { resolvedProfile } : {}),
    ...(resolvedModel !== null ? { resolvedModel } : {}),
    ...(resolvedModelId !== null ? { resolvedModelId } : {}),
    ...(displayLabels !== null ? displayLabels : {}),
    ...(speed ? { speed } : {}),
    usage,
  };
}

function parseTaskRunSpeed(value: unknown): TaskRunSpeedEvidence | null {
  const record = asRecord(value);
  if (!record) return null;
  const effectiveTps = readCount(record.effective_tps);
  const source = readSpeedSource(record.source);
  if (effectiveTps === null || source === null) return null;
  const sampleCount = readCount(record.sample_count);
  const expectedTpsMet = readBoolean(record.expected_tps_met);
  return {
    effectiveTps,
    source,
    sampleCount: sampleCount !== null ? sampleCount : null,
    expectedTpsMet: expectedTpsMet !== null ? expectedTpsMet : null,
    ...(typeof record.degradation_reason === 'string' && record.degradation_reason.length > 0
      ? { degradationReason: record.degradation_reason }
      : {}),
  };
}

function parseTaskRunUsage(value: unknown): TaskRunUsage | null {
  const record = asRecord(value);
  if (!record) return null;
  const attemptCount = readCount(record.attempt_count);
  const usageEventCount = readCount(record.usage_event_count);
  if (attemptCount === null || usageEventCount === null) return null;
  const completeness = readCompleteness(record.completeness);
  const referenceCostUsd = readNumber(record.reference_cost_usd);
  const referenceCostComplete = record.reference_cost_complete === true;
  if (referenceCostComplete && referenceCostUsd === null) return null;
  // A missing reference cost is retained as `undefined` (not dropped) for runs
  // that are not fully costed; a real numeric zero is preserved verbatim and is
  // not substituted. Structural validation above (attempt/usage counts) still
  // applies, so unrelated malformed rows are rejected.
  return {
    completeness: completeness ?? (referenceCostComplete ? 'complete' : 'partial'),
    attemptCount,
    usageEventCount,
    ...(readNumber(record.input_tokens) !== null ? { inputTokens: record.input_tokens as number } : {}),
    ...(readNumber(record.cached_input_tokens) !== null ? { cachedInputTokens: record.cached_input_tokens as number } : {}),
    ...(readNumber(record.cache_read_input_tokens) !== null ? { cacheReadInputTokens: record.cache_read_input_tokens as number } : {}),
    ...(readNumber(record.cache_creation_input_tokens) !== null ? { cacheCreationInputTokens: record.cache_creation_input_tokens as number } : {}),
    ...(readNumber(record.output_tokens) !== null ? { outputTokens: record.output_tokens as number } : {}),
    ...(readNumber(record.total_tokens) !== null ? { totalTokens: record.total_tokens as number } : {}),
    ...(readNumber(record.generation_ms) !== null ? { generationMs: record.generation_ms as number } : {}),
    ...(readNumber(record.output_tps) !== null ? { outputTps: record.output_tps as number } : {}),
    ...(record.tps_contract === 'tokenizer_v1' ? { tpsContract: 'tokenizer_v1' as const } : {}),
    ...(referenceCostUsd !== null ? { referenceCostUsd } : {}),
    referenceCostComplete,
    ...(typeof record.reference_cost_basis === 'string' && record.reference_cost_basis.length > 0
      ? { referenceCostBasis: record.reference_cost_basis }
      : {}),
  };
}

function readTaskRunId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : null;
}

function readTaskId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function readSpeedSource(value: unknown): TaskRunSpeedEvidence['source'] | null {
  return value === 'local_31d' || value === 'provider_override' || value === 'catalog_default' ? value : null;
}

function readCompleteness(value: unknown): TaskRunUsage['completeness'] | null {
  return value === 'complete' || value === 'partial' || value === 'unavailable' ? value : null;
}

function isTaskRunStatus(value: unknown): value is TaskRunSnapshot['status'] {
  return value === 'done' || value === 'failed' || value === 'cancelled' || value === 'interrupted'
    || value === 'running' || value === 'queued';
}

function isTaskSource(value: unknown): value is 'builtin' | 'project' | 'unknown' {
  return value === 'builtin' || value === 'project' || value === 'unknown';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;
}

function readCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
