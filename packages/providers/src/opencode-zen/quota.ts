import type { Provider } from '../base/provider.ts';
import { balancePool, quotaPool } from '../base/quota-helpers.ts';

// No verified official balance API (confirmed 2026-09-18); usage is unknown by design.
const ZEN_BALANCE_POOL = balancePool('opencode-zen/balance', '', '2026-09-08', true);

const ZEN_FREE_POOL = quotaPool('opencode-zen/free', []);

export const quota = {
  bindings: [],
  pools: [ZEN_BALANCE_POOL],
  defaultPools: [ZEN_FREE_POOL],
} satisfies Provider['quota'];
