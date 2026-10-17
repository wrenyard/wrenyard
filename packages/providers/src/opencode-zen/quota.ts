import type { Provider } from '../base/provider.ts';
import { binding, quotaPool, balancePool } from '../base/quota-helpers.ts';

const ZEN_BALANCE_POOL = balancePool('opencode-zen/balance', '');

const ZEN_FREE_POOL = quotaPool('opencode-zen/free', []);

export const quota = {
  bindings: [
    // Free membership is live from the public catalog, so it is never hard-coded
    // here: a free row binds to the default free pool and its confirmed-free
    // synthesis, never to a paid balance. Only paid rows keep explicit bindings.
    binding('opencode-zen', 'glm-5.3', [ZEN_BALANCE_POOL]),
    binding('opencode-zen', 'kimi-k3', [ZEN_BALANCE_POOL]),
    binding('opencode-zen', 'gpt-6.1-sol', [ZEN_BALANCE_POOL]),
    binding('opencode-zen', 'gemini-4-argon', [ZEN_BALANCE_POOL]),
  ],
  defaultPools: [ZEN_FREE_POOL],
} satisfies Provider['quota'];
