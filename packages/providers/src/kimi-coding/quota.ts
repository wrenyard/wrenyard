import type { Provider } from '../base/provider.ts';
import { binding, quotaWindow, quotaPool } from '../base/quota-helpers.ts';

const KIMI_DOCS = 'https://www.kimi.com/code/docs/en/kimi-code/membership.html';

const KIMI_7D_POOL = quotaPool('kimi-coding/7d', [
  quotaWindow('7d', 'full_cycle', 'official_docs', KIMI_DOCS),
]);

const KIMI_5H_POOL = quotaPool('kimi-coding/5h', [
  quotaWindow('5h', 'rolling_partial', 'official_docs', KIMI_DOCS),
]);

export const quota = {
  bindings: [
    binding('kimi-coding', 'k3', [KIMI_5H_POOL, KIMI_7D_POOL]),
    // K2.8 Preview draws on the same Kimi Coding subscription as K3.
    binding('kimi-coding', 'kimi-k2.8', [KIMI_5H_POOL, KIMI_7D_POOL]),
  ],
  defaultPools: [KIMI_5H_POOL, KIMI_7D_POOL],
} satisfies Provider['quota'];
