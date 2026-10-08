/**
 * Reasoning-effort selection and the client-local first-request record.
 *
 * Every effort decision delegates to the product-owned ladder exported by
 * `@wrenyard/models` (nearest supported level at or above the request, else the
 * highest supported), so the composer picker, the context meter and the send
 * path can never disagree. A route-owned effort list is non-empty by contract.
 *
 * A brand-new session inherits the model and effort of the previous session's
 * FIRST request. That record lives only in Desktop local state (never in the
 * retired `session.*` preferences), and a later request in the same session
 * never overwrites it.
 */
import {
  REASONING_EFFORTS,
  resolveReasoningEffort,
  type ReasoningEffort,
} from '@wrenyard/models';

export type { ReasoningEffort };
export { REASONING_EFFORTS };

/** True for one of the six product-owned effort levels. */
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value);
}

/**
 * Normalize an unknown effort token. Only a concrete ladder level survives; a
 * retired alias or any other non-level value is `undefined`. There is no
 * `midium` alias.
 */
export function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
  return isReasoningEffort(value) ? value : undefined;
}

/**
 * Nearest supported level at or above the requested `expected`, else the
 * highest supported level. `expected` is required — there is no omitted-input
 * "take the highest" path. An empty `supported` list throws (the shared
 * contract forbids it).
 */
export function nearestReasoningEffort(
  expected: ReasoningEffort,
  supported: readonly ReasoningEffort[],
): ReasoningEffort {
  return resolveReasoningEffort(expected, supported);
}

/**
 * Keep `current` when the target route supports it; otherwise resolve the
 * nearest-supported rule. An unusable `current` resolves from the explicit
 * `medium` feature default rather than the ladder top.
 */
export function retainReasoningEffort(
  current: unknown,
  supported: readonly ReasoningEffort[],
): ReasoningEffort {
  const normalized = normalizeReasoningEffort(current);
  if (normalized !== undefined && supported.includes(normalized)) return normalized;
  return resolveReasoningEffort(normalized ?? 'medium', supported);
}

/** Initial effort of a brand-new session: `medium` resolved nearest-else-highest. */
export function initialReasoningEffort(supported: readonly ReasoningEffort[]): ReasoningEffort {
  return resolveReasoningEffort('medium', supported);
}

// ─── Client-local first-request record ─────────────────────────────────────

/** The model public id and effort of a session's first request. */
export interface FirstRequest {
  model: string;
  effort: ReasoningEffort;
}

/** Minimal `Storage` surface; satisfied by `window.localStorage` and fakes. */
export interface FirstRequestStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Desktop local-state key; distinct from every retired `session.*` preference. */
export const FIRST_REQUEST_KEY = 'session:first-request';

/**
 * The record to persist after a send. Only a session's FIRST request is
 * remembered: once the session has already sent, nothing is written
 * (`undefined`), even when no record is stored yet. The first send replaces
 * any previous session's record.
 */
export function firstRequestAfterSend(
  existing: FirstRequest | undefined,
  request: FirstRequest,
  alreadySentInSession: boolean,
): FirstRequest | undefined {
  // A later request never claims the first-request slot, regardless of whether a
  // record exists; only a session's first request may write.
  if (alreadySentInSession) return undefined;
  return request;
}

/** Decode a persisted first-request value; malformed or retired input is dropped. */
export function decodeFirstRequest(raw: unknown): FirstRequest | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as { model?: unknown; effort?: unknown };
  const effort = normalizeReasoningEffort(record.effort);
  if (typeof record.model !== 'string' || record.model === '' || effort === undefined) return undefined;
  return { model: record.model, effort };
}

function defaultStorage(): FirstRequestStorage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** Read the remembered first request, or `undefined` when absent/unusable. */
export function readFirstRequest(storage?: FirstRequestStorage): FirstRequest | undefined {
  const store = storage ?? defaultStorage();
  if (store === undefined) return undefined;
  try {
    return decodeFirstRequest(store.getItem(FIRST_REQUEST_KEY));
  } catch {
    return undefined;
  }
}

/** Persist the remembered first request. Local-state writes are best-effort. */
export function writeFirstRequest(record: FirstRequest, storage?: FirstRequestStorage): void {
  const store = storage ?? defaultStorage();
  if (store === undefined) return;
  try {
    store.setItem(FIRST_REQUEST_KEY, JSON.stringify(record));
  } catch {
    // Local state is best-effort; an unavailable store degrades to no memory.
  }
}
