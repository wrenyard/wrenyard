/**
 * Fixed production preview fixtures (FU-004 / IU-003).
 *
 * 34 fixed cases (25 worker + 9 house) in the exact semantic contract order. No Date.now / randomness:
 * every timestamp is derived from `nowMs` (fixed at 10000) and the explicit
 * state plus per-case `initNowMs`. The production capture iterates the combined
 * array with semantic filenames.
 */

export const FIXTURE_VIEWPORT = {
  width: 640,
  height: 360,
  dpr: 1,
  scale: 5,
  nowMs: 10000,
};

export const HOUSE_FIXTURE_VIEWPORT = {
  width: 360,
  height: 460,
  dpr: 1,
  scale: 5,
  nowMs: 10000,
};

export const VALID_SKIN_IDS = [
  'classic-codebuddy',
  'classic-codex',
  'classic-claude',
  'classic-voxel-miner',
  'red-jumper',
  'green-quest',
  'blue-dash',
  'block-miner',
  'space-bounty',
  'arcade-ghost',
  'rune-mage',
  'shadow-ninja',
  'slime-king',
];

const PHASES = ['working', 'sleeping', 'celebrating', 'dejected'];
const CLIENTS = ['claude', 'codebuddy', 'codex', 'unknown'];

const CAPTURE_MS = FIXTURE_VIEWPORT.nowMs;

function skinKind(skinId) {
  if (skinId === 'classic-codebuddy' || skinId === 'classic-codex' || skinId === 'classic-claude') return 'official';
  if (skinId === 'classic-voxel-miner') return 'classic';
  return 'original';
}

function baseAppearance(skinId, tool = '#1F3D6D') {
  return {
    profile: 'classic',
    profileLabel: 'Preview',
    skin: {
      kind: skinKind(skinId),
      id: skinId,
      name: skinId,
      colors: { primary: '#2F7DE1', accent: '#8FE3FF', tool },
    },
  };
}

function worker(overrides = {}) {
  return {
    workerIdentityKey: 'visual-worker',
    profile: 'preview',
    client: 'unknown',
    phase: 'working',
    appearance: baseAppearance('classic-voxel-miner'),
    sinceMs: 9000,
    toolCount: 0,
    startedAt: -72000,
    ...overrides,
  };
}

function mkFixture(file, overrides, initNowMs) {
  return {
    kind: 'worker',
    file,
    value: worker(overrides),
    initNowMs: initNowMs ?? CAPTURE_MS,
  };
}

function mkSkin(skinId, overrides = {}) {
  const { tool, ...workerOverrides } = overrides;
  const w = worker(workerOverrides);
  w.appearance = baseAppearance(skinId, tool);
  return { kind: 'worker', file: `worker-skin-${skinId}.png`, value: w, initNowMs: CAPTURE_MS };
}

/** The 25 fixed worker cases, in the exact semantic contract order. */
export const WORKER_FIXTURES = [
  // ─── 13 skin cases (working, unknown client, no tools/bubble) ────────
  ...VALID_SKIN_IDS.map((id) => mkSkin(id, { client: 'unknown' })),

  // ─── 4 phase cases (classic-voxel-miner) ─────────────────────────────
  ...PHASES.map((phase) => mkFixture(
    `worker-phase-${phase}.png`,
    {
      phase,
      appearance: baseAppearance('classic-voxel-miner', '#1F3D6D'),
      client: 'unknown',
    },
  )),

  // ─── 4 badge cases (classic-voxel-miner, working) ────────────────────
  ...CLIENTS.map((client) => mkFixture(
    `worker-badge-${client}.png`,
    {
      appearance: baseAppearance('classic-voxel-miner', '#1F3D6D'),
      client,
    },
  )),

  // ─── 2 tool cases ─────────────────────────────────────────────────────
  mkFixture(
    'worker-tool-classic-voxel-miner.png',
    {
      appearance: baseAppearance('classic-voxel-miner', '#1F3D6D'),
      toolCount: 22,
      lastToolTs: 9000,
    },
  ),
  mkFixture(
    'worker-tool-blue-dash.png',
    {
      appearance: baseAppearance('blue-dash', '#1F3D6D'),
      toolCount: 22,
      lastToolTs: 9000,
    },
  ),

  // ─── 2 bubble cases ───────────────────────────────────────────────────
  mkFixture(
    'worker-bubble-cjk-reveal.png',
    {
      appearance: baseAppearance('classic-codebuddy', '#0d4a9e'),
      bubble: {
        text: '编排进行中 Pixi ready',
        untilMs: 12000,
      },
    },
    9750,
  ),
  mkFixture(
    'worker-bubble-cjk-fade.png',
    {
      appearance: baseAppearance('classic-codebuddy', '#0d4a9e'),
      bubble: {
        text: '编排进行中 Pixi ready',
        untilMs: 10400,
      },
    },
    0,
  ),
];

const HOUSE_CAPTURE_MS = HOUSE_FIXTURE_VIEWPORT.nowMs;
const HOUSE_LOGICAL_W = HOUSE_FIXTURE_VIEWPORT.width / HOUSE_FIXTURE_VIEWPORT.scale;
const HOUSE_LOGICAL_H = HOUSE_FIXTURE_VIEWPORT.height / HOUSE_FIXTURE_VIEWPORT.scale;
const HOUSE_X = Math.max(0, Math.floor((HOUSE_LOGICAL_W - 48) / 2));
const HOUSE_Y = Math.max(0, HOUSE_LOGICAL_H - 40);
const HOUSE_RECT = {
  x: HOUSE_X * HOUSE_FIXTURE_VIEWPORT.scale,
  y: HOUSE_Y * HOUSE_FIXTURE_VIEWPORT.scale,
  width: 48 * HOUSE_FIXTURE_VIEWPORT.scale,
  height: 40 * HOUSE_FIXTURE_VIEWPORT.scale,
};

function houseState(overrides = {}) {
  return {
    houseSkin: 'classic',
    scale: HOUSE_FIXTURE_VIEWPORT.scale,
    workers: [],
    queuedCount: 0,
    ...overrides,
  };
}

function houseFixture(file, overrides = {}, pointer = { x: -1, y: -1, inside: false }) {
  return {
    kind: 'house',
    file,
    value: houseState(overrides),
    pointer,
    dragging: false,
    initNowMs: HOUSE_CAPTURE_MS,
  };
}

/** Nine fixed house cases, appended after the 25 worker cases. */
export const HOUSE_FIXTURES = [
  houseFixture('house-base.png'),
  houseFixture(
    'house-status-queued.png',
    {
      workers: [
        { phase: 'working' },
        { phase: 'sleeping' },
      ],
      queuedCount: 3,
    },
  ),
  houseFixture(
    'house-broadcast-sticky.png',
    {
      broadcast: {
        id: 'visual-broadcast',
        text: 'Pixi migration ready',
        intensity: 'sticky',
      },
    },
  ),
  houseFixture(
    'house-stats-hover.png',
    {
      workers: [{ phase: 'working' }],
      taskgraphCount: 2,
      dailyStats: {
        dayKey: '2026-07-10',
        startAt: '2026-07-09T16:00:00.000Z',
        endAt: '2026-07-10T16:00:00.000Z',
        dispatchCount: 314,
        inputTokens: 191000000,
        outputTokens: 2000000,
        totalTokens: 193000000,
        source: 'sqlite',
      },
      quotaTips: [
        {
          text: 'codex-spark 7d 25%',
          bars: [{
            provider: { remainingPct: 25, expectedRemainingPct: null, windows: [{ name: '7d', usedPct: 75, remainingPct: 25, expectedRemainingPct: null }] },
            label: 'codex-spark',
            error: null,
            status: 'ok',
            stale: false,
          }],
        },
        {
          text: 'kimi-coding 5h 80%',
          bars: [{
            provider: {
              remainingPct: 80,
              expectedRemainingPct: 90,
              windows: [
                { name: '5h', usedPct: 20, remainingPct: 80, expectedRemainingPct: 90 },
                { name: '7d', usedPct: 40, remainingPct: 60, expectedRemainingPct: 50 },
                { name: '1mo', usedPct: 72.5, remainingPct: 27.5, expectedRemainingPct: null },
              ],
            },
            label: 'kimi-coding',
            error: null,
            status: 'ok',
            stale: false,
          }],
        },
        {
          text: 'super-grok error \u2014 rate limit hit',
          errorRow: { label: 'super-grok', message: 'error \u2014 rate limit hit' },
          bars: [{
            provider: null,
            label: 'super-grok',
            error: 'rate limit hit',
            status: 'error',
            stale: false,
          }],
        },
      ],
    },
    {
      x: HOUSE_RECT.x + HOUSE_RECT.width / 2,
      y: HOUSE_RECT.y + HOUSE_RECT.height / 2,
      inside: true,
    },
  ),
  houseFixture(
    'house-active-queued.png',
    {
      workers: [
        { phase: 'working' },
        { phase: 'celebrating' },
      ],
      queuedCount: 3,
      taskgraphCount: 1,
      dailyStats: {
        dayKey: '2026-07-19',
        startAt: '2026-07-18T16:00:00.000Z',
        endAt: '2026-07-19T16:00:00.000Z',
        dispatchCount: 22,
        inputTokens: 2345,
        outputTokens: 6789,
        totalTokens: 9134,
        source: 'sqlite',
      },
    },
    {
      x: HOUSE_RECT.x + HOUSE_RECT.width / 2,
      y: HOUSE_RECT.y + HOUSE_RECT.height / 2,
      inside: true,
    },
  ),
  houseFixture(
    'house-high-tier.png',
    {
      workers: [
        { phase: 'working' },
        { phase: 'working' },
      ],
      queuedCount: 1,
      taskgraphCount: 2,
      dailyStats: {
        dayKey: '2026-07-19',
        startAt: '2026-07-18T16:00:00.000Z',
        endAt: '2026-07-19T16:00:00.000Z',
        dispatchCount: 500,
        inputTokens: 250000,
        outputTokens: 250000,
        totalTokens: 500000000,
        source: 'sqlite',
      },
    },
    {
      x: HOUSE_RECT.x + HOUSE_RECT.width / 2,
      y: HOUSE_RECT.y + HOUSE_RECT.height / 2,
      inside: true,
    },
  ),
  houseFixture('house-mushroom-base.png', { houseSkin: 'mushroom' }),
  houseFixture(
    'house-mushroom-active-queued.png',
    {
      houseSkin: 'mushroom',
      workers: [
        { phase: 'working' },
        { phase: 'celebrating' },
      ],
      queuedCount: 3,
      taskgraphCount: 1,
      dailyStats: {
        dayKey: '2026-07-19',
        startAt: '2026-07-18T16:00:00.000Z',
        endAt: '2026-07-19T16:00:00.000Z',
        dispatchCount: 22,
        inputTokens: 2345,
        outputTokens: 6789,
        totalTokens: 9134,
        source: 'sqlite',
      },
    },
    {
      x: HOUSE_RECT.x + HOUSE_RECT.width / 2,
      y: HOUSE_RECT.y + HOUSE_RECT.height / 2,
      inside: true,
    },
  ),
  houseFixture(
    'house-mushroom-high-tier.png',
    {
      houseSkin: 'mushroom',
      workers: [
        { phase: 'working' },
        { phase: 'working' },
      ],
      queuedCount: 1,
      taskgraphCount: 2,
      dailyStats: {
        dayKey: '2026-07-19',
        startAt: '2026-07-18T16:00:00.000Z',
        endAt: '2026-07-19T16:00:00.000Z',
        dispatchCount: 500,
        inputTokens: 250000,
        outputTokens: 250000,
        totalTokens: 500000000,
        source: 'sqlite',
      },
    },
    {
      x: HOUSE_RECT.x + HOUSE_RECT.width / 2,
      y: HOUSE_RECT.y + HOUSE_RECT.height / 2,
      inside: true,
    },
  ),
];

export const PREVIEW_FIXTURES = [
  ...WORKER_FIXTURES,
  ...HOUSE_FIXTURES,
];

/** Serialize a fixture into a compact JSON string passed to the renderer. */
export function serializeFixture(fixture) {
  return JSON.stringify(fixture);
}
