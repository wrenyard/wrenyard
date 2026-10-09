/**
 * Composer reasoning-effort choice and the Desktop-local record of the previous
 * session's first request, which a brand-new session starts from.
 */
import { REASONING_EFFORTS, resolveReasoningEffort, type ReasoningEffort } from '@wrenyard/models';

export type { ReasoningEffort };

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly unknown[]).includes(value);
}

/** Keep `current` when the route supports it; otherwise resolve from `medium` by the nearest-supported rule. */
export function retainReasoningEffort(current: unknown, supported: readonly ReasoningEffort[]): ReasoningEffort {
  return resolveReasoningEffort(isReasoningEffort(current) ? current : 'medium', supported);
}

export interface FirstRequest {
  model: string;
  effort: ReasoningEffort;
}

const FIRST_REQUEST_KEY = 'session:first-request';

export function readFirstRequest(): FirstRequest | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(FIRST_REQUEST_KEY) ?? '') as Partial<FirstRequest> | null;
    if (typeof value?.model !== 'string' || value.model === '' || !isReasoningEffort(value.effort)) return undefined;
    return { model: value.model, effort: value.effort };
  } catch {
    return undefined;
  }
}

export function writeFirstRequest(record: FirstRequest): void {
  try {
    localStorage.setItem(FIRST_REQUEST_KEY, JSON.stringify(record));
  } catch {
    // Local state is best-effort.
  }
}
