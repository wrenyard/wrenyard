import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { quota } from '../src/deepseek/quota.js';
import type { QuotaSource } from '../src/base/provider-quota.js';
import type { QuotaSnapshot } from '../src/base/quota-snapshot.js';

const OBSERVED_SOURCE = 'deepseek-balance';
const OBSERVED_AT = '2026-10-08T02:48:58.056Z';

/** In-memory QuotaSource: read() returns the fixed observation envelope. */
function sourceReturning(data: unknown): QuotaSource {
  return {
    read: async () => ({ data, source: OBSERVED_SOURCE, fetched_at: OBSERVED_AT }),
  };
}

/** Drive quota.read() through the in-memory source and assert a snapshot. */
async function read(data: unknown): Promise<QuotaSnapshot> {
  const snapshot = await quota.read(sourceReturning(data));
  assert.ok(snapshot, 'expected a quota snapshot');
  return snapshot;
}

describe('deepseek quota normalization', () => {
  it('accepts a positive balance and preserves exact metadata', async () => {
    const snapshot = await read({
      is_available: true,
      balance_infos: [{ currency: 'cny', total_balance: '12.34' }],
    });
    assert.deepEqual(snapshot, {
      provider: 'deepseek',
      status: 'ok',
      stale: false,
      source: OBSERVED_SOURCE,
      fetched_at: OBSERVED_AT,
      balances: [{ currency: 'CNY', amount: '12.34' }],
    });
  });

  it('treats is_available=false with a zero balance as exhausted, not failed', async () => {
    // false signals insufficient funds, which is a valid observation.
    const snapshot = await read({
      is_available: false,
      balance_infos: [{ currency: 'CNY', total_balance: '0.00' }],
    });
    assert.equal(snapshot.status, 'ok');
    assert.deepEqual(snapshot.balances, [{ currency: 'CNY', amount: '0.00' }]);
  });

  it('normalizes the real exhausted payload (-0.00) to CNY 0.00', async () => {
    // Exact endpoint payload for an insufficient-funds account.
    const snapshot = await read({
      is_available: false,
      balance_infos: [
        {
          currency: 'CNY',
          total_balance: '-0.00',
          granted_balance: '0.00',
          topped_up_balance: '-0.00',
        },
      ],
    });
    assert.equal(snapshot.status, 'ok');
    assert.equal(snapshot.source, OBSERVED_SOURCE);
    assert.equal(snapshot.fetched_at, OBSERVED_AT);
    assert.deepEqual(snapshot.balances, [{ currency: 'CNY', amount: '0.00' }]);
  });

  it('normalizes negative zero even when is_available=true, keeping magnitude', async () => {
    const cases: ReadonlyArray<readonly [input: string, expected: string]> = [
      ['-0', '0'],
      ['-0.0', '0.0'],
      ['-0.000', '0.000'],
      ['-0.00', '0.00'],
    ];
    for (const [input, expected] of cases) {
      const snapshot = await read({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: input }],
      });
      assert.deepEqual(snapshot.balances, [{ currency: 'CNY', amount: expected }], input);
    }
  });

  it('rejects missing and non-boolean availability', async () => {
    const invalid: unknown[] = [
      { balance_infos: [{ currency: 'CNY', total_balance: '0.00' }] },
      { is_available: 'true', balance_infos: [{ currency: 'CNY', total_balance: '0.00' }] },
      { is_available: 1, balance_infos: [{ currency: 'CNY', total_balance: '0.00' }] },
      { is_available: null, balance_infos: [{ currency: 'CNY', total_balance: '0.00' }] },
    ];
    for (const payload of invalid) {
      await assert.rejects(() => read(payload), /Balance unavailable/);
    }
  });

  it('rejects missing or empty balance_infos', async () => {
    await assert.rejects(() => read({ is_available: true }), /Balance unavailable/);
    await assert.rejects(
      () => read({ is_available: false, balance_infos: [] }),
      /Balance unavailable/,
    );
  });

  it('rejects malformed amounts and negative non-zero balances', async () => {
    const cases = ['abc', '', '1.2.3', '12,34', '- 0', '-1.00', '-0.01'];
    for (const total_balance of cases) {
      await assert.rejects(
        () => read({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance }] }),
        /Invalid monetary balance/,
        total_balance,
      );
    }
  });

  it('rejects malformed currency codes and missing amounts', async () => {
    await assert.rejects(
      () => read({ is_available: true, balance_infos: [{ currency: 'EURO', total_balance: '1.00' }] }),
      /Invalid monetary balance/,
    );
    await assert.rejects(
      () => read({ is_available: true, balance_infos: [{ currency: 'CNY' }] }),
      /Invalid monetary balance/,
    );
  });
});
