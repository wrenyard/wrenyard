import { bareModelId } from '@wrenyard/providers/catalog';

export type GatewayHealthOutcome =
  | 'success'
  | 'upstream_error'
  | 'timeout'
  | 'connection_failure'
  | 'other_failure'
  | 'cancelled'
  | 'caller_error'
  | 'admission_refusal';

const UPSTREAM_FAULT_REASONS = new Set([
  'rate_limited',
  'quota_exhausted',
  'auth_failed',
  'access_denied',
  'model_unavailable',
  'server_error',
]);

const OTHER_FAULT_REASONS = new Set(['empty_stream', 'structured_output']);

export function classifyGatewayOutcome(args: {
  status: number;
  faultReason?: string;
  hasUpstreamError?: boolean;
  admissionRefusal?: boolean;
  cancelled?: boolean;
}): { outcome: GatewayHealthOutcome; failureClass?: string } {
  if (args.admissionRefusal === true) return { outcome: 'admission_refusal' };
  if (args.cancelled === true) return { outcome: 'cancelled' };
  if (args.faultReason === 'timeout') return { outcome: 'timeout' };
  if (args.faultReason === 'transport') return { outcome: 'connection_failure' };
  if (args.faultReason !== undefined && UPSTREAM_FAULT_REASONS.has(args.faultReason)) {
    return { outcome: 'upstream_error', failureClass: args.faultReason };
  }
  if (args.faultReason !== undefined && OTHER_FAULT_REASONS.has(args.faultReason)) {
    return { outcome: 'other_failure', failureClass: args.faultReason };
  }
  if (args.status >= 200 && args.status < 300) return { outcome: 'success' };
  if (
    args.status < 500
    && args.faultReason === undefined
    && args.hasUpstreamError !== true
    && (args.status < 200 || args.status >= 300)
  ) {
    return { outcome: 'caller_error' };
  }
  return { outcome: 'other_failure', ...(args.faultReason === undefined ? {} : { failureClass: args.faultReason }) };
}

const BUCKET_MS = 60_000;
const RETENTION_MS = 24 * 60 * 60 * 1000;

export interface GatewayHealthWindowFigures {
  requests: number;
  successes: number;
  failures: Record<string, number>;
  cancelled: number;
  callerErrors: number;
  admissionRefusals: number;
  medianFirstResponseMs?: number;
  medianTps?: number;
  lastSuccessAt?: string;
  lastFailure?: { at: string; class: string; reason: string };
}

export interface GatewayHealthRouteSnapshot {
  provider: string;
  model: string;
  last1h: GatewayHealthWindowFigures;
  last24h: GatewayHealthWindowFigures;
}

export interface GatewayHealthProviderSnapshot {
  provider: string;
  last1h: GatewayHealthWindowFigures;
  last24h: GatewayHealthWindowFigures;
}

export interface GatewayHealthPoolSnapshot {
  provider: string;
  pool: string;
  last1h: GatewayHealthWindowFigures;
  last24h: GatewayHealthWindowFigures;
}

interface MinuteBucket {
  minute: number;
  success: number;
  failures: Record<string, number>;
  cancelled: number;
  callerError: number;
  admissionRefusal: number;
  firstResponseMs: number[];
  tps: number[];
  lastSuccessAt?: number;
  lastFailure?: { at: number; class: string; reason: string };
}

export interface GatewayHealthRecordInput {
  provider: string;
  publicModel: string;
  timestamp: number;
  outcome: GatewayHealthOutcome;
  failureClass?: string;
  failureReason?: string;
  firstResponseMs?: number;
  tps?: number;
}

export interface GatewayHealthStore {
  record(input: GatewayHealthRecordInput): void;
  snapshot(now?: number): GatewayHealthRouteSnapshot[];
  /** Merge minute buckets for the given route keys; medians use pooled raw samples. */
  aggregate(routeKeys: readonly string[], now?: number): {
    last1h: GatewayHealthWindowFigures;
    last24h: GatewayHealthWindowFigures;
  };
}

function routeKey(provider: string, publicModel: string): string {
  const separator = publicModel.indexOf('/');
  const modelPart = separator > 0 ? publicModel.slice(separator + 1) : publicModel;
  return `${provider}/${bareModelId(modelPart)}`;
}

function splitRouteKey(key: string): { provider: string; model: string } {
  const separator = key.indexOf('/');
  return { provider: key.slice(0, separator), model: key.slice(separator + 1) };
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function emptyWindow(): GatewayHealthWindowFigures {
  return {
    requests: 0,
    successes: 0,
    failures: {},
    cancelled: 0,
    callerErrors: 0,
    admissionRefusals: 0,
  };
}

function failureKey(outcome: GatewayHealthOutcome, failureClass?: string): string | undefined {
  if (outcome === 'upstream_error' || outcome === 'other_failure') return failureClass ?? outcome;
  if (outcome === 'timeout' || outcome === 'connection_failure') return failureClass ?? outcome;
  return failureClass;
}

function applyBucket(bucket: MinuteBucket, input: GatewayHealthRecordInput): void {
  switch (input.outcome) {
    case 'success':
      bucket.success += 1;
      bucket.lastSuccessAt = input.timestamp;
      break;
    case 'cancelled':
      bucket.cancelled += 1;
      break;
    case 'caller_error':
      bucket.callerError += 1;
      break;
    case 'admission_refusal':
      bucket.admissionRefusal += 1;
      break;
    default: {
      const key = failureKey(input.outcome, input.failureClass);
      if (key !== undefined) bucket.failures[key] = (bucket.failures[key] ?? 0) + 1;
      bucket.lastFailure = {
        at: input.timestamp,
        class: input.failureClass ?? input.outcome,
        reason: input.failureReason ?? '',
      };
      break;
    }
  }
  if (input.firstResponseMs !== undefined && Number.isFinite(input.firstResponseMs)) {
    bucket.firstResponseMs.push(input.firstResponseMs);
  }
  if (input.tps !== undefined && Number.isFinite(input.tps)) {
    bucket.tps.push(input.tps);
  }
}

/** Shared window rollup for one or more routes' minute buckets. */
function windowFiguresFromBuckets(buckets: MinuteBucket[], sinceMs: number): GatewayHealthWindowFigures {
  const window = emptyWindow();
  const firstResponseSamples: number[] = [];
  const tpsSamples: number[] = [];
  let lastSuccessAt: number | undefined;
  let lastFailure: { at: number; class: string; reason: string } | undefined;

  for (const bucket of buckets) {
    if (bucket.minute < sinceMs) continue;
    const requests =
      bucket.success
      + bucket.cancelled
      + bucket.callerError
      + bucket.admissionRefusal
      + Object.values(bucket.failures).reduce((sum, count) => sum + count, 0);
    window.requests += requests;
    window.successes += bucket.success;
    window.cancelled += bucket.cancelled;
    window.callerErrors += bucket.callerError;
    window.admissionRefusals += bucket.admissionRefusal;
    for (const [key, count] of Object.entries(bucket.failures)) {
      window.failures[key] = (window.failures[key] ?? 0) + count;
    }
    firstResponseSamples.push(...bucket.firstResponseMs);
    tpsSamples.push(...bucket.tps);
    if (bucket.lastSuccessAt !== undefined && (lastSuccessAt === undefined || bucket.lastSuccessAt >= lastSuccessAt)) {
      lastSuccessAt = bucket.lastSuccessAt;
    }
    if (bucket.lastFailure !== undefined && (lastFailure === undefined || bucket.lastFailure.at >= lastFailure.at)) {
      lastFailure = bucket.lastFailure;
    }
  }

  const medianFirstResponseMs = median(firstResponseSamples);
  const medianTps = median(tpsSamples);
  return {
    ...window,
    ...(medianFirstResponseMs === undefined ? {} : { medianFirstResponseMs }),
    ...(medianTps === undefined ? {} : { medianTps }),
    ...(lastSuccessAt === undefined ? {} : { lastSuccessAt: new Date(lastSuccessAt).toISOString() }),
    ...(lastFailure === undefined ? {} : {
      lastFailure: {
        at: new Date(lastFailure.at).toISOString(),
        class: lastFailure.class,
        reason: lastFailure.reason,
      },
    }),
  };
}

export function createGatewayHealthStore(now: () => number = Date.now): GatewayHealthStore {
  const routes = new Map<string, MinuteBucket[]>();

  const prune = (key: string, current: number): void => {
    const cutoff = current - RETENTION_MS;
    const buckets = routes.get(key);
    if (buckets === undefined) return;
    const kept = buckets.filter((bucket) => bucket.minute >= cutoff);
    if (kept.length === 0) routes.delete(key);
    else routes.set(key, kept);
  };

  return {
    record(input) {
      const current = input.timestamp;
      const key = routeKey(input.provider, input.publicModel);
      const minute = Math.floor(current / BUCKET_MS) * BUCKET_MS;
      let buckets = routes.get(key);
      if (buckets === undefined) {
        buckets = [];
        routes.set(key, buckets);
      }
      let bucket = buckets.find((candidate) => candidate.minute === minute);
      if (bucket === undefined) {
        bucket = {
          minute,
          success: 0,
          failures: {},
          cancelled: 0,
          callerError: 0,
          admissionRefusal: 0,
          firstResponseMs: [],
          tps: [],
        };
        buckets.push(bucket);
      }
      applyBucket(bucket, input);
      prune(key, current);
    },

    snapshot(at = now()) {
      const oneHour = at - 60 * 60 * 1000;
      const twentyFourHours = at - RETENTION_MS;
      const result: GatewayHealthRouteSnapshot[] = [];
      for (const [key, buckets] of routes) {
        prune(key, at);
        const kept = routes.get(key);
        if (kept === undefined || kept.length === 0) continue;
        const { provider, model } = splitRouteKey(key);
        result.push({
          provider,
          model,
          last1h: windowFiguresFromBuckets(kept, oneHour),
          last24h: windowFiguresFromBuckets(kept, twentyFourHours),
        });
      }
      return result;
    },

    aggregate(routeKeys, at = now()) {
      const oneHour = at - 60 * 60 * 1000;
      const twentyFourHours = at - RETENTION_MS;
      const merged: MinuteBucket[] = [];
      for (const key of routeKeys) {
        prune(key, at);
        const kept = routes.get(key);
        if (kept !== undefined) merged.push(...kept);
      }
      return {
        last1h: windowFiguresFromBuckets(merged, oneHour),
        last24h: windowFiguresFromBuckets(merged, twentyFourHours),
      };
    },
  };
}
