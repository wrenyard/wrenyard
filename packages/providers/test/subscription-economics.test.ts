import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSubscriptionEconomics } from '../src/subscription-economics.ts';

const u = (s: string) => Date.parse(s);

// Domestic peak (Mon-Fri UTC+8 14:00-18:00) => multiplier 1 => worst efficiency 0.
test('domestic peak yields worst efficiency 0', () => {
  const r = resolveSubscriptionEconomics({
    provider: 'zhipu-coding',
    model: 'glm-5.3',
    client: 'opencode',
    atMs: u('2026-09-14T14:00:00+08:00'),
    throughMs: u('2026-09-14T15:00:00+08:00'),
    authenticated: true,
  });
  assert.ok(r);
  assert.equal(r.efficiencyScore, 0);
  assert.equal(r.quotaTokenCoefficients?.unit, 'quota-coefficients-per-10000-tokens');
});

// Domestic weekend off-peak => multiplier 0.5 => efficiency 0.5.
test('domestic weekend off-peak yields efficiency 0.5', () => {
  const r = resolveSubscriptionEconomics({
    provider: 'zhipu-coding',
    model: 'glm-5.3',
    client: 'opencode',
    atMs: u('2026-09-19T10:00:00+08:00'),
    throughMs: u('2026-09-19T11:00:00+08:00'),
    authenticated: true,
  });
  assert.ok(r);
  assert.equal(r.efficiencyScore, 0.5);
});

// Mixed horizon picks the worst (peak) multiplier => efficiency 0.
test('crossing 14:00/18:00 chooses worst peak', () => {
  const r = resolveSubscriptionEconomics({
    provider: 'zhipu-coding',
    model: 'glm-5.3',
    client: 'opencode',
    atMs: u('2026-09-14T13:00:00+08:00'),
    throughMs: u('2026-09-14T19:00:00+08:00'),
    authenticated: true,
  });
  assert.ok(r);
  assert.equal(r.efficiencyScore, 0);
});

// Flash campaign night discounts further (higher efficiency) than non-flash night.
test('flash campaign night better than non-flash night', () => {
  const flash = resolveSubscriptionEconomics({
    provider: 'zhipu-coding',
    model: 'glm-5.3-flash',
    client: 'opencode',
    atMs: u('2026-09-15T23:30:00+08:00'),
    throughMs: u('2026-09-16T00:30:00+08:00'),
    authenticated: true,
  });
  const nonFlash = resolveSubscriptionEconomics({
    provider: 'zhipu-coding',
    model: 'glm-5.3',
    client: 'opencode',
    atMs: u('2026-09-15T23:30:00+08:00'),
    throughMs: u('2026-09-16T00:30:00+08:00'),
    authenticated: true,
  });
  assert.ok(flash && nonFlash);
  assert.ok(flash.efficiencyScore > nonFlash.efficiencyScore);
  assert.equal(flash.source, 'https://docs.bigmodel.cn/cn/coding-plan/overview ; https://docs.bigmodel.cn/cn/coding-plan/notice/event-glm-5.3-flash');
});

// Campaign expires conservatively at Sep21 00:00 UTC+8; post-midnight is standard.
test('campaign expires Sep21 00:00 UTC+8', () => {
  const crossing = resolveSubscriptionEconomics({
    provider: 'zhipu-coding',
    model: 'glm-5.3-flash',
    client: 'opencode',
    atMs: u('2026-09-20T23:30:00+08:00'),
    throughMs: u('2026-09-21T00:30:00+08:00'),
    authenticated: true,
  });
  const onlyCampaign = resolveSubscriptionEconomics({
    provider: 'zhipu-coding',
    model: 'glm-5.3-flash',
    client: 'opencode',
    atMs: u('2026-09-15T23:30:00+08:00'),
    throughMs: u('2026-09-16T00:30:00+08:00'),
    authenticated: true,
  });
  assert.ok(crossing && onlyCampaign);
  assert.ok(crossing.efficiencyScore < onlyCampaign.efficiencyScore);
});

// Non-flash models never receive the campaign discount.
test('non-flash model gets no campaign multiplier', () => {
  const r = resolveSubscriptionEconomics({
    provider: 'zhipu-coding',
    model: 'glm-5.3',
    client: 'opencode',
    atMs: u('2026-09-15T23:30:00+08:00'),
    throughMs: u('2026-09-16T00:30:00+08:00'),
    authenticated: true,
  });
  assert.ok(r);
  assert.equal(r.quotaTokenCoefficients?.output, 24 * 0.5); // m=0.5, no campaign
});

// Unsupported provider / client / model => undefined.
test('unsupported provider is undefined', () => {
  assert.equal(
    resolveSubscriptionEconomics({
      provider: 'CodeBuddy',
      model: 'glm-5.3',
      client: 'opencode',
      atMs: u('2026-09-14T14:00:00+08:00'),
      throughMs: u('2026-09-14T15:00:00+08:00'),
      authenticated: true,
    }),
    undefined,
  );
});

test('unsupported client is undefined', () => {
  assert.equal(
    resolveSubscriptionEconomics({
      provider: 'zhipu-coding',
      model: 'glm-5.3',
      client: 'vscode',
      atMs: u('2026-09-14T14:00:00+08:00'),
      throughMs: u('2026-09-14T15:00:00+08:00'),
      authenticated: true,
    }),
    undefined,
  );
});

test('unknown model is undefined', () => {
  assert.equal(
    resolveSubscriptionEconomics({
      provider: 'zhipu-coding',
      model: 'gpt-4',
      client: 'opencode',
      atMs: u('2026-09-14T14:00:00+08:00'),
      throughMs: u('2026-09-14T15:00:00+08:00'),
      authenticated: true,
    }),
    undefined,
  );
});

// Unauthenticated / invalid / too-long horizon => undefined.
test('unauthenticated is undefined', () => {
  assert.equal(
    resolveSubscriptionEconomics({
      provider: 'zhipu-coding',
      model: 'glm-5.3',
      client: 'opencode',
      atMs: u('2026-09-14T14:00:00+08:00'),
      throughMs: u('2026-09-14T15:00:00+08:00'),
      authenticated: false,
    }),
    undefined,
  );
});

test('reversed horizon is undefined', () => {
  assert.equal(
    resolveSubscriptionEconomics({
      provider: 'zhipu-coding',
      model: 'glm-5.3',
      client: 'opencode',
      atMs: u('2026-09-14T15:00:00+08:00'),
      throughMs: u('2026-09-14T14:00:00+08:00'),
      authenticated: true,
    }),
    undefined,
  );
});

test('horizon longer than 7 days is undefined', () => {
  assert.equal(
    resolveSubscriptionEconomics({
      provider: 'zhipu-coding',
      model: 'glm-5.3',
      client: 'opencode',
      atMs: u('2026-09-14T00:00:00+08:00'),
      throughMs: u('2026-09-22T00:00:00+08:00'),
      authenticated: true,
    }),
    undefined,
  );
});

test('horizon before provenance date is undefined', () => {
  assert.equal(
    resolveSubscriptionEconomics({
      provider: 'zhipu-coding',
      model: 'glm-5.3',
      client: 'opencode',
      atMs: u('2026-09-09T14:00:00+08:00'),
      throughMs: u('2026-09-09T15:00:00+08:00'),
      authenticated: true,
    }),
    undefined,
  );
});

// Go efficiency ratio 10/60 vs 10/15.
test('Go efficiency ratio 10/60 vs 10/15', () => {
  const flash = resolveSubscriptionEconomics({
    provider: 'opencode-go',
    model: 'glm-5.3-flash',
    client: 'opencode',
    atMs: u('2026-09-14T00:00:00+08:00'),
    throughMs: u('2026-09-14T01:00:00+08:00'),
    authenticated: true,
  });
  const glm = resolveSubscriptionEconomics({
    provider: 'opencode-go',
    model: 'glm-5.3',
    client: 'opencode',
    atMs: u('2026-09-14T00:00:00+08:00'),
    throughMs: u('2026-09-14T01:00:00+08:00'),
    authenticated: true,
  });
  assert.ok(flash && glm);
  assert.ok(Math.abs(flash.efficiencyScore - (1 - 10 / 60)) < 1e-9);
  assert.ok(Math.abs(glm.efficiencyScore - (1 - 10 / 15)) < 1e-9);
  assert.ok(flash.efficiencyScore > glm.efficiencyScore);
});

// Go: explicit full-utilization estimate, separated from any actual price.
test('Go exposes full-utilization estimate only', () => {
  const r = resolveSubscriptionEconomics({
    provider: 'opencode-go',
    model: 'glm-5.3-flash',
    client: 'opencode',
    atMs: u('2026-09-14T00:00:00+08:00'),
    throughMs: u('2026-09-14T01:00:00+08:00'),
    authenticated: true,
  });
  assert.ok(r);
  assert.equal(r.quotaTokenCoefficients?.unit, 'usd-allowance-per-million-tokens');
  assert.ok(r.amortizedEstimate);
  assert.equal(r.amortizedEstimate?.monthlySubscriptionUsd, 10);
  assert.equal(r.amortizedEstimate?.monthlyAllowanceUsd, 60);
  assert.ok(Math.abs(r.amortizedEstimate?.fullUtilizationOutputUsdPerMillion - (0.5 * 10) / 60) < 1e-9);
  assert.match(r.amortizedEstimate?.note ?? '', /NOT an actual/i);
});
