/**
 * Composer reasoning-effort choice and the Desktop-local records of the previous
 * session's first request and of each model's last chosen level. The pure
 * parse/resolve/write logic lives in `reasoning-effort-memory.ts`; this module
 * is the thin `localStorage` wrapper around it.
 */
import { REASONING_EFFORTS, resolveReasoningEffort, type ReasoningEffort } from '@wrenyard/models';
import {
  MODEL_EFFORTS_STORAGE_KEY,
  parseModelEfforts,
  withModelEffort,
  type ModelEffortMemory,
} from './reasoning-effort-memory.js';

export type { ReasoningEffort };
export type { ModelEffortMemory };

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
  /** The Fast value used for the first request; `false` is a real choice. */
  fast?: boolean;
}

const FIRST_REQUEST_KEY = 'session:first-request';

/**
 * Read the previous session's first request. `supportsFast` decides whether the
 * remembered model still declares the Fast capability; a record for a model
 * without it carries no Fast preference, so a stale `true` is never restored.
 */
export function readFirstRequest(
  supportsFast?: (modelId: string) => boolean,
): FirstRequest | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(FIRST_REQUEST_KEY) ?? '') as Partial<FirstRequest> | null;
    if (typeof value?.model !== 'string' || value.model === '' || !isReasoningEffort(value.effort)) return undefined;
    if (value.model === 'auto') return { model: value.model, effort: value.effort };
    const fast = typeof value.fast === 'boolean' && (supportsFast === undefined || supportsFast(value.model))
      ? { fast: value.fast }
      : {};
    return { model: value.model, effort: value.effort, ...fast };
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

/** Read the per-model reasoning-effort memory; missing or corrupt storage reads as empty. */
export function readModelEfforts(): ModelEffortMemory {
  try {
    return parseModelEfforts(localStorage.getItem(MODEL_EFFORTS_STORAGE_KEY));
  } catch {
    return parseModelEfforts(null);
  }
}

/** Remember `effort` for exactly `publicId`; every other model's entry is left untouched. */
export function writeModelEffort(publicId: string, effort: ReasoningEffort): void {
  try {
    const memory = withModelEffort(readModelEfforts(), publicId, effort);
    localStorage.setItem(MODEL_EFFORTS_STORAGE_KEY, JSON.stringify(memory));
  } catch {
    // Local state is best-effort.
  }
}
