import { SCORE_WEIGHTS } from '@wrenyard/auto-routing';
import type { TaskSettingsRoutingWeights } from '@/shell-contract';

/**
 * Pure model for the routing-weights control. This module owns only the four
 * percent values and their conversion to/from the daemon wire fraction shape;
 * it never touches React, the DOM, or the settings API.
 */

/** The four editable weight fields, in the fixed display order. */
export const ROUTING_WEIGHT_KEYS = ['price', 'speed', 'quota', 'intelligence'] as const;
export type RoutingWeightKey = (typeof ROUTING_WEIGHT_KEYS)[number];

/** Percent labels: 价格 / 速度 / 额度 / 智能. */
export const ROUTING_WEIGHT_LABELS: Record<RoutingWeightKey, string> = {
  price: '价格',
  speed: '速度',
  quota: '额度',
  intelligence: '智能',
};

/** Percent value per field, keyed by the wire field name. */
export interface RoutingWeightsPercent {
  price: number;
  speed: number;
  quota: number;
  intelligence: number;
}

const PERCENT_SUM = 100;

/**
 * SSOT default percent weights (40/30/20/10) derived from the Catalog
 * `SCORE_WEIGHTS` fractions. `P`→价格, `S`→速度, `Q`→额度, `I`→智能.
 */
export function defaultRoutingWeightsPercent(): RoutingWeightsPercent {
  return {
    price: SCORE_WEIGHTS.P * PERCENT_SUM,
    speed: SCORE_WEIGHTS.S * PERCENT_SUM,
    quota: SCORE_WEIGHTS.Q * PERCENT_SUM,
    intelligence: SCORE_WEIGHTS.I * PERCENT_SUM,
  };
}

/**
 * Parses and validates one percent input. Rejects empty/non-numeric/non-finite
 * values and anything outside the range 0..100.
 */
export function parseRoutingWeightPercent(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new Error('请输入百分比数值');
  const value = Number(trimmed);
  if (!Number.isFinite(value)) throw new Error('请输入有效数值');
  if (value < 0 || value > 100) throw new Error('数值需在 0 到 100 之间');
  return value;
}

/**
 * Parses all four raw inputs into a validated percent set. Throws on any
 * malformed field or when the four values do not sum to exactly 100.
 */
export function parseRoutingWeightsInput(input: Record<RoutingWeightKey, string>): RoutingWeightsPercent {
  const parsed = {} as RoutingWeightsPercent;
  for (const key of ROUTING_WEIGHT_KEYS) {
    parsed[key] = parseRoutingWeightPercent(input[key]);
  }
  const total = parsed.price + parsed.speed + parsed.quota + parsed.intelligence;
  if (total !== PERCENT_SUM) throw new Error(`四项权重之和必须为 100（当前 ${total}）`);
  return parsed;
}

/** Converts a validated percent set into the fraction wire shape. */
export function routingWeightsFromPercent(percent: RoutingWeightsPercent): TaskSettingsRoutingWeights {
  return {
    price: percent.price / PERCENT_SUM,
    speed: percent.speed / PERCENT_SUM,
    quota: percent.quota / PERCENT_SUM,
    intelligence: percent.intelligence / PERCENT_SUM,
  };
}

/** Converts a stored override (or missing override) into percent form. */
export function routingWeightsToPercent(
  weights: TaskSettingsRoutingWeights | null | undefined,
): RoutingWeightsPercent {
  if (weights === null || weights === undefined) return defaultRoutingWeightsPercent();
  return {
    price: weights.price * PERCENT_SUM,
    speed: weights.speed * PERCENT_SUM,
    quota: weights.quota * PERCENT_SUM,
    intelligence: weights.intelligence * PERCENT_SUM,
  };
}

/** Input text for one percent field: whole percents render without a fraction. */
export function routingWeightInputValue(percent: number): string {
  return String(Math.round(percent * 100) / 100);
}

/** Turns a percent set into the string map backing the four inputs. */
export function routingWeightsToInput(percent: RoutingWeightsPercent): Record<RoutingWeightKey, string> {
  return {
    price: routingWeightInputValue(percent.price),
    speed: routingWeightInputValue(percent.speed),
    quota: routingWeightInputValue(percent.quota),
    intelligence: routingWeightInputValue(percent.intelligence),
  };
}
