import type { ActionExecutionOutcome } from '../reasoning/actions.ts';

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function renderRunFiles(files: readonly { path: string; bytes: number }[]): string {
  if (files.length === 0) return 'The task directory has no files';
  return ['Files in the task directory:', ...files.map((file) => `- ${file.path} (${file.bytes} bytes)`)].join('\n');
}

export function fail(reason: string): ActionExecutionOutcome {
  return { status: 'failed', result: reason, deferred: [] };
}

/** At most this many attempts of one auxiliary call, failed calls and rejected outputs together. */
export const AUXILIARY_ATTEMPTS = 3;

/**
 * The shared light retry of one auxiliary call: up to AUXILIARY_ATTEMPTS
 * immediate attempts with no backoff, each handed the previous failure so it
 * can tell the model what went wrong. A route that failed is already recorded
 * in route state, so the next attempt's selection moves on by itself.
 */
export async function withAuxiliaryRetry<T, F extends { error: string }>(
  attempt: (previous: F | undefined) => Promise<{ ok: true; value: T } | ({ ok: false } & F)>,
  signal?: AbortSignal,
): Promise<{ ok: true; value: T } | ({ ok: false } & F) | { ok: false; error: string }> {
  let previous: ({ ok: false } & F) | undefined;
  for (let n = 0; n < AUXILIARY_ATTEMPTS && signal?.aborted !== true; n += 1) {
    const result = await attempt(previous);
    if (result.ok) return result;
    previous = result;
  }
  return previous ?? { ok: false, error: 'aborted before the first attempt' };
}
