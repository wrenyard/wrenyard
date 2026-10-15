// Worker skin selection: probability, pool size, uniformity, boundaries,
// stability, client classification and legacy id compatibility.
//
// Run with: pnpm --filter @wrenyard/desktop exec tsx --test test/pet/appearance.test.ts

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLASSIC_SKIN_IDS,
  getAppearance,
  NATIVE_SHARE_BASIS_POINTS,
  nativeSkinIds,
  nonNativeSkinIds,
  OFFICIAL_SKIN_IDS,
  ORIGINAL_SKIN_IDS,
  pickSkinId,
  SKIN_CATALOG,
  skinById,
} from '../../src/pet/features/worker/appearance';
import { isWorkerSkinId, normalizeAppearance, VALID_SKIN_IDS } from '../../src/pet/features/worker/scene/palette';
import { classifyWorkerClient } from '../../src/pet/main/model/client-family';
import type { WorkerClient, WorkerSkinId } from '../../src/pet/shared/snapshot';

const SEEDS = 20000;
const CLIENTS: readonly WorkerClient[] = ['codebuddy', 'codex', 'claude', 'dsh'];

function repeatPool(ids: readonly WorkerSkinId[], size: number): WorkerSkinId[] {
  const pool: WorkerSkinId[] = [];
  for (let i = 0; i < size; i++) pool.push(ids[i % ids.length]);
  return pool;
}

test('native share stays near 80% per client and never leaks across pools', () => {
  for (const client of CLIENTS) {
    const nativePool = nativeSkinIds(client);
    const nonNativePool = nonNativeSkinIds();
    assert.ok(nativePool.length > 0, `${client} should have native skins`);

    let nativeHits = 0;
    for (let i = 0; i < SEEDS; i++) {
      const id = pickSkinId(nativePool, nonNativePool, `run-${i}`);
      assert.ok(id, `seed run-${i} must select a skin`);
      if (nativePool.includes(id)) {
        nativeHits++;
        assert.ok(nativePool.includes(id));
      } else {
        assert.ok(!OFFICIAL_SKIN_IDS.includes(id), `non-native pick ${id} must not be official`);
      }
    }

    const share = nativeHits / SEEDS;
    assert.ok(Math.abs(share - 0.8) <= 0.015, `${client} native share ${share.toFixed(4)}`);
  }
});

test('pool size never dilutes the 80/20 split', () => {
  const nativeOne = [OFFICIAL_SKIN_IDS[0]];
  const nativeMany = repeatPool(OFFICIAL_SKIN_IDS, 30);
  const nonNativeOne = [nonNativeSkinIds()[0]];
  const nonNativeMany = repeatPool(nonNativeSkinIds(), 30);

  const combos: Array<[readonly WorkerSkinId[], readonly WorkerSkinId[]]> = [
    [nativeOne, nonNativeOne],
    [nativeOne, nonNativeMany],
    [nativeMany, nonNativeOne],
    [nativeMany, nonNativeMany],
  ];

  for (const [nativePool, nonNativePool] of combos) {
    let nativeHits = 0;
    for (let i = 0; i < SEEDS; i++) {
      const id = pickSkinId(nativePool, nonNativePool, `run-${i}`);
      assert.ok(id);
      if (nativePool.includes(id)) nativeHits++;
    }
    const share = nativeHits / SEEDS;
    assert.ok(
      Math.abs(share - 0.8) <= 0.015,
      `native share ${share.toFixed(4)} for pools ${nativePool.length}/${nonNativePool.length}`,
    );
  }
});

test('selection is uniform inside a 20-entry non-native pool', () => {
  const pool = nonNativeSkinIds();
  assert.equal(pool.length, 20);

  const total = 40000;
  const counts = new Map<WorkerSkinId, number>(pool.map((id) => [id, 0] as const));
  for (let i = 0; i < total; i++) {
    const id = pickSkinId([], pool, `uniform-${i}`);
    assert.ok(id);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  for (const [id, count] of counts) {
    const share = count / total;
    assert.ok(Math.abs(share - 1 / pool.length) <= 0.01, `${id} share ${share.toFixed(4)}`);
  }
});

test('empty pools: all non-native, all native, both empty', () => {
  const nonNativePool = nonNativeSkinIds();
  const unknownNativePool = nativeSkinIds('unknown');
  const nativePool = nativeSkinIds('codebuddy');
  assert.equal(unknownNativePool.length, 0);
  assert.ok(nativePool.length > 0);

  for (let i = 0; i < 2000; i++) {
    const onlyNonNative = pickSkinId(unknownNativePool, nonNativePool, `empty-${i}`);
    assert.ok(onlyNonNative !== null);
    assert.ok(!OFFICIAL_SKIN_IDS.includes(onlyNonNative));

    const onlyNative = pickSkinId(nativePool, [], `empty-${i}`);
    assert.ok(onlyNative !== null);
    assert.ok(nativePool.includes(onlyNative));
  }

  assert.equal(pickSkinId([], [], 'both-empty'), null);

  const fallback = skinById('crew-runner');
  assert.ok(fallback, 'crew-runner fallback skin must exist in the catalog');
  assert.equal(fallback.id, 'crew-runner');

  const appearance = getAppearance('unknown-profile', 'identity', 'unknown');
  assert.ok(isWorkerSkinId(appearance.skin.id));
});

test('selection is stable and prefers the run id over the identity key', () => {
  const nativePool = nativeSkinIds('codex');
  const nonNativePool = nonNativeSkinIds();
  const first = pickSkinId(nativePool, nonNativePool, 'seed-x');
  const second = pickSkinId(nativePool, nonNativePool, 'seed-x');
  const third = pickSkinId(nativePool, nonNativePool, 'seed-x');
  assert.equal(first, second);
  assert.equal(second, third);

  const withRunA = getAppearance('p', 'identity-1', 'codex', 'run-abc');
  const withRunB = getAppearance('p', 'identity-2', 'codex', 'run-abc');
  assert.equal(withRunA.skin.id, withRunB.skin.id);
  assert.equal(withRunA.profileLabel, 'p');
});

test('classifyWorkerClient classifies by client identity only', () => {
  assert.equal(classifyWorkerClient('codebuddy/deepseek-v4.1-flash:cb'), 'codebuddy');
  assert.equal(classifyWorkerClient('deepseek/deepseek-flash:gk'), 'unknown');
  assert.equal(classifyWorkerClient('x/deepseek:dsh'), 'dsh');
  assert.equal(classifyWorkerClient('anthropic/claude-x:cur'), 'unknown');
  assert.equal(classifyWorkerClient('chatgpt/gpt-5.6-luna:codex'), 'codex');
  assert.equal(classifyWorkerClient('cb-dsf'), 'codebuddy');
  assert.equal(classifyWorkerClient('codex-spark'), 'codex');
  assert.equal(classifyWorkerClient('cb-dsf', 'claude'), 'codebuddy');
  assert.equal(classifyWorkerClient('zhipu-coding/glm-5.3:oc', 'opencode'), 'unknown');
  assert.equal(classifyWorkerClient('foo', 'dsh'), 'dsh');
  assert.equal(classifyWorkerClient('codex-spark', 'cursor'), 'unknown');
  // The run-syntax client key wins over the recorded client family.
  assert.equal(classifyWorkerClient('codebuddy/deepseek-v4.1-flash:cb', 'claude'), 'codebuddy');
  assert.equal(classifyWorkerClient('cursor/grok-4.7:cur', 'cursor'), 'unknown');
  assert.equal(classifyWorkerClient('x/y:dsh', 'claude'), 'dsh');
});

test('legacy ids stay valid with their catalog kinds', () => {
  assert.equal(SKIN_CATALOG.length, 27);
  assert.equal(OFFICIAL_SKIN_IDS.length, 7);
  assert.equal(CLASSIC_SKIN_IDS.length, 10);
  assert.equal(ORIGINAL_SKIN_IDS.length, 10);
  assert.equal(VALID_SKIN_IDS.size, 27);

  const legacy: readonly WorkerSkinId[] = [
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
  assert.equal(legacy.length, 13);

  for (const id of legacy) {
    assert.ok(isWorkerSkinId(id), `${id} must stay valid`);
    const entry = skinById(id);
    assert.ok(entry, `${id} must exist in the catalog`);
    const isClientMascot = id === 'classic-codebuddy' || id === 'classic-codex' || id === 'classic-claude';
    assert.equal(entry.kind, isClientMascot ? 'official' : 'classic');

    const normalized = normalizeAppearance({
      profile: 'legacy-profile',
      profileLabel: 'legacy-profile',
      skin: {
        kind: entry.kind,
        id,
        name: id,
        colors: { primary: '#112233', accent: '#445566', tool: '#778899' },
      },
    });
    assert.equal(normalized.skin.id, id);
  }

  assert.equal(skinById('classic-codebuddy')?.client, 'codebuddy');
  assert.equal(skinById('classic-codex')?.client, 'codex');
  assert.equal(skinById('classic-claude')?.client, 'claude');
});

test('distribution report', () => {
  const clients: readonly WorkerClient[] = ['codebuddy', 'codex', 'claude', 'dsh', 'unknown'];
  const rows: string[] = [];

  for (const client of clients) {
    const nativePool = nativeSkinIds(client);
    const nonNativePool = nonNativeSkinIds();
    const counts = new Map<WorkerSkinId, number>();
    let nativeHits = 0;

    for (let i = 0; i < SEEDS; i++) {
      const id = pickSkinId(nativePool, nonNativePool, `run-${i}`);
      assert.ok(id);
      counts.set(id, (counts.get(id) ?? 0) + 1);
      if (nativePool.includes(id)) nativeHits++;
    }

    rows.push(
      `client ${client}: native ${((nativeHits / SEEDS) * 100).toFixed(2)}% / ` +
        `non-native ${(((SEEDS - nativeHits) / SEEDS) * 100).toFixed(2)}% ` +
        `(${NATIVE_SHARE_BASIS_POINTS}bp target)`,
    );
    for (const [id, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      rows.push(`    ${id} ${count} (${((count / SEEDS) * 100).toFixed(2)}%)`);
    }
  }

  console.log(`\n${rows.join('\n')}\n`);
  assert.ok(rows.length > 0);
});
