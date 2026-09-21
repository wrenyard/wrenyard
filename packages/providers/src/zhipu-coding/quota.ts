import type { Provider } from '../base/provider.ts';
import { binding, quotaWindow, quotaPool } from '../base/quota-helpers.ts';

const ZHIPU_DOCS = 'https://docs.bigmodel.cn/cn/coding-plan/overview';

const ZHIPU_7D_POOL = quotaPool('zhipu-coding/7d', [
  quotaWindow('7d', 'full_cycle', 'official_docs', ZHIPU_DOCS, '2026-09-09'),
]);

const ZHIPU_5H_POOL = quotaPool('zhipu-coding/5h', [
  quotaWindow('5h', 'rolling_partial', 'official_docs', ZHIPU_DOCS, '2026-09-09'),
]);

export const quota = {
  bindings: [
    // Zhipu coding preserves the proven 5h rolling / 7d full-cycle resets.
    binding('zhipu-coding', 'glm-5.3', [ZHIPU_5H_POOL, ZHIPU_7D_POOL]),
    binding('zhipu-coding', 'glm-5.3-flash', [ZHIPU_5H_POOL, ZHIPU_7D_POOL]),
  ],
  defaultPools: [ZHIPU_5H_POOL, ZHIPU_7D_POOL],
} satisfies Provider['quota'];
