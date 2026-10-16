/**
 * Pure per-model reasoning-effort memory. The store is a JSON object keyed by
 * model `publicId` (`provider/model`), each entry the level that model last had
 * chosen. This module holds only the parse/resolve/write logic — no
 * `localStorage`, and no TS-only syntax — so `node --test` can import it
 * directly; `reasoning-effort.ts` adds the thin storage wrapper.
 */
import { REASONING_EFFORTS, resolveReasoningEffort, type ReasoningEffort } from '@wrenyard/models';

export type { ReasoningEffort };

/** localStorage key holding the per-model reasoning-effort memory. */
export const MODEL_EFFORTS_STORAGE_KEY = 'session:model-efforts';

/** Remembered reasoning-effort level per model, keyed by `publicId` (`provider/model`). */
export type ModelEffortMemory = Readonly<Record<string, ReasoningEffort>>;

/** The shared empty memory; a missing, corrupt or unusable store reads as this. */
export const EMPTY_MODEL_EFFORT_MEMORY: ModelEffortMemory = {};

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly unknown[]).includes(value);
}

/**
 * Parse a raw stored value into the per-model memory. A missing, empty,
 * non-object or corrupt JSON value yields an empty memory; a valid object keeps
 * only its well-formed `publicId: level` entries and drops the rest.
 */
export function parseModelEfforts(raw: string | null | undefined): ModelEffortMemory {
  if (typeof raw !== 'string' || raw === '') return EMPTY_MODEL_EFFORT_MEMORY;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return EMPTY_MODEL_EFFORT_MEMORY;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return EMPTY_MODEL_EFFORT_MEMORY;
  const memory: Record<string, ReasoningEffort> = {};
  for (const [publicId, effort] of Object.entries(value as Record<string, unknown>)) {
    if (publicId !== '' && isReasoningEffort(effort)) memory[publicId] = effort;
  }
  return memory;
}

/**
 * The level recalled for one model: its remembered level resolved against that
 * model's own `supported` ladder by the nearest-supported rule. `undefined`
 * when the model has no remembered level, or no ladder to resolve it against,
 * so the caller keeps that model's own default rather than another model's
 * value.
 */
export function resolveModelEffort(
  memory: ModelEffortMemory,
  publicId: string,
  supported: readonly ReasoningEffort[],
): ReasoningEffort | undefined {
  const remembered = memory[publicId];
  if (remembered === undefined || supported.length === 0) return undefined;
  try {
    return resolveReasoningEffort(remembered, supported);
  } catch {
    // A remembered level this route cannot satisfy is treated as no memory.
    return undefined;
  }
}

/** A model's own default level: the nearest supported level at or above `medium`. Requires a non-empty ladder. */
export function defaultModelEffort(supported: readonly ReasoningEffort[]): ReasoningEffort {
  return resolveReasoningEffort('medium', supported);
}

/**
 * A new memory that sets only `publicId` to `effort`, carrying every other
 * model's key over untouched. Choosing a level for one model therefore can
 * never write another model's preference.
 */
export function withModelEffort(
  memory: ModelEffortMemory,
  publicId: string,
  effort: ReasoningEffort,
): ModelEffortMemory {
  if (publicId === '') return memory;
  return { ...memory, [publicId]: effort };
}
