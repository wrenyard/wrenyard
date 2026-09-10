// Provider-scoped subscription economics resolver.
// Pure, clock-injected (no network, no credential reads). Never returns actual
// monetary marginal prices for Go; only explicitly labeled full-utilization
// amortized estimates. Conservative: unknown input => undefined.

export interface SubscriptionEconomicsInput {
  provider: string;
  model: string;
  client: string;
  atMs: number;
  throughMs: number;
  authenticated: boolean;
}

export interface TokenCoefficients {
  input: number;
  cached: number;
  output: number;
  unit: 'quota-coefficients-per-10000-tokens' | 'usd-allowance-per-million-tokens';
}

export interface AmortizedEstimate {
  label: string;
  monthlySubscriptionUsd: number;
  monthlyAllowanceUsd: number;
  fullUtilizationOutputUsdPerMillion: number;
  note: string;
}

export interface SubscriptionEconomicsResult {
  provider: string;
  model: string;
  client: string;
  authenticated: true;
  provenance: string;
  source: string;
  ruleId: string;
  atMs: number;
  throughMs: number;
  efficiencyScore: number;
  quotaTokenCoefficients: TokenCoefficients | null;
  amortizedEstimate?: AmortizedEstimate;
  sharedPlanConstraints?: { fiveHourPct: number; weeklyPct: number; monthlyPct: number };
}

const TZ8 = 8 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const MAX_HORIZON_MS = 7 * DAY_MS;
const PROVENANCE_MS = Date.parse('2026-09-10T00:00:00+08:00');
const CAMPAIGN_START = Date.parse('2026-09-03T00:00:00+08:00');
const CAMPAIGN_END = Date.parse('2026-09-21T00:00:00+08:00');
const DOMESTIC_CLIENTS = ['claude', 'codebuddy', 'opencode'];

// Official quota coefficients (weighted tokens divided by 10000) (standard, pre-multiplier).
const DOMESTIC: Record<string, { input: number; cached: number; output: number }> = {
  'glm-5.3': { input: 6.9, cached: 1.7, output: 24 },
  'glm-5.3-flash': { input: 2.3, cached: 0.56, output: 8 },
};

// OpenCode Go USD allowance rates (per million tokens) and monthly allowance.
const GO_SUBSCRIPTION_USD = 10;
const GO_MODELS: Record<string, { monthlyLimit: number; input: number; cached: number; output: number }> = {
  'glm-5.3-flash': { monthlyLimit: 60, input: 0.15, cached: 0.03, output: 0.5 },
  'glm-5.3': { monthlyLimit: 15, input: 1.4, cached: 0.26, output: 4.4 },
  'deepseek-flash': { monthlyLimit: 15, input: 0.3, cached: 0.006, output: 1.2 },
  hy3: { monthlyLimit: 60, input: 0.14, cached: 0.035, output: 0.58 },
};

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// Wall-clock hour (float) in UTC+8 for an absolute ms instant.
function hourUtc8(ms: number): number {
  const d = new Date(ms + TZ8);
  return d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
}

function dayUtc8(ms: number): number {
  return new Date(ms + TZ8).getUTCDay();
}

function utc8Midnight(ms: number): number {
  const d = new Date(ms + TZ8);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() - TZ8;
}

// Sample endpoints + every transition (09:00, 14:00, 18:00, 23:00 UTC+8) for each
// day in the closed horizon. Bounded by the <=7 day horizon.
function sampleInstants(atMs: number, throughMs: number): number[] {
  const out = new Set<number>();
  out.add(atMs);
  out.add(throughMs);
  const firstDay = utc8Midnight(atMs);
  const lastDay = utc8Midnight(throughMs);
  for (let day = firstDay; day <= lastDay; day += DAY_MS) {
    for (const h of [9, 14, 18, 23]) {
      const t = day + h * 3600 * 1000;
      if (t >= atMs && t <= throughMs) out.add(t);
    }
  }
  return [...out];
}

// Domestic multiplier: peak (Mon-Fri UTC+8 14:00-18:00) = 1.0, else 0.5.
// Flash campaign (Sep3-Sep20 2026, night 23:00-09:00 UTC+8) applies an
// additional halving (conservative discount) to standard off-peak.
function domesticMultiplier(ms: number, isFlash: boolean): number {
  const hour = hourUtc8(ms);
  const weekday = dayUtc8(ms) >= 1 && dayUtc8(ms) <= 5;
  const isPeak = weekday && hour >= 14 && hour < 18;
  let m = isPeak ? 1 : 0.5;
  if (isFlash && ms >= CAMPAIGN_START && ms < CAMPAIGN_END) {
    const isNight = hour >= 23 || hour < 9;
    if (isNight) m *= 0.5;
  }
  return m;
}

function resolveDomestic(input: SubscriptionEconomicsInput): SubscriptionEconomicsResult | undefined {
  const base = DOMESTIC[input.model];
  if (!base) return undefined;
  if (!DOMESTIC_CLIENTS.includes(input.client)) return undefined;

  const isFlash = input.model === 'glm-5.3-flash';
  let maxM = 0;
  for (const t of sampleInstants(input.atMs, input.throughMs)) {
    const m = domesticMultiplier(t, isFlash);
    if (m > maxM) maxM = m;
  }
  const eff = clamp01(1 - Math.max((base.input * maxM) / 6.9, (base.cached * maxM) / 1.7, (base.output * maxM) / 24));

  return {
    provider: input.provider,
    model: input.model,
    client: input.client,
    authenticated: true,
    provenance: 'checked2026-09-10',
    source: isFlash
      ? 'https://docs.bigmodel.cn/cn/coding-plan/overview ; https://docs.bigmodel.cn/cn/coding-plan/notice/event-glm-5.3-flash'
      : 'https://docs.bigmodel.cn/cn/coding-plan/overview',
    ruleId: 'zhipu-coding-domestic',
    atMs: input.atMs,
    throughMs: input.throughMs,
    efficiencyScore: eff,
    quotaTokenCoefficients: {
      input: base.input * maxM,
      cached: base.cached * maxM,
      output: base.output * maxM,
      unit: 'quota-coefficients-per-10000-tokens',
    },
  };
}

function resolveGo(input: SubscriptionEconomicsInput): SubscriptionEconomicsResult | undefined {
  if (input.client !== 'opencode') return undefined;
  const m = GO_MODELS[input.model];
  if (!m) return undefined;

  const eff = clamp01(1 - GO_SUBSCRIPTION_USD / m.monthlyLimit);
  return {
    provider: input.provider,
    model: input.model,
    client: input.client,
    authenticated: true,
    provenance: 'checked2026-09-10',
    source: 'https://opencode.ai/docs/go/',
    ruleId: 'opencode-go-subscription',
    atMs: input.atMs,
    throughMs: input.throughMs,
    efficiencyScore: eff,
    quotaTokenCoefficients: {
      input: m.input,
      cached: m.cached,
      output: m.output,
      unit: 'usd-allowance-per-million-tokens',
    },
    // Explicitly labeled estimate assuming fully consumed monthly allowance.
    // NOT an actual per-call / marginal monetary price.
    amortizedEstimate: {
      label: 'full-utilization amortized estimate (NOT actual per-call charge)',
      monthlySubscriptionUsd: GO_SUBSCRIPTION_USD,
      monthlyAllowanceUsd: m.monthlyLimit,
      fullUtilizationOutputUsdPerMillion: (m.output * GO_SUBSCRIPTION_USD) / m.monthlyLimit,
      note: 'Assumes the $10/month subscription fully consumes the monthly allowance; not an actual marginal price.',
    },
    // Shared-plan constraints, not additive extra balances.
    sharedPlanConstraints: { fiveHourPct: 20, weeklyPct: 50, monthlyPct: 100 },
  };
}

export function resolveSubscriptionEconomics(
  input: SubscriptionEconomicsInput,
): SubscriptionEconomicsResult | undefined {
  if (!input.authenticated) return undefined;
  if (!Number.isFinite(input.atMs) || !Number.isFinite(input.throughMs)) return undefined;
  if (input.throughMs < input.atMs) return undefined;
  if (input.throughMs - input.atMs > MAX_HORIZON_MS) return undefined;
  if (input.atMs < PROVENANCE_MS) return undefined;

  if (input.provider === 'zhipu-coding') return resolveDomestic(input);
  if (input.provider === 'opencode-go') return resolveGo(input);
  return undefined;
}
