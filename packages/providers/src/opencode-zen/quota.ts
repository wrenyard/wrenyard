import type { Provider } from '../base/provider.ts';
import { binding, quotaPool, balancePool } from '../base/quota-helpers.ts';

const ZEN_BALANCE_POOL = balancePool('opencode-zen/balance', '');

const ZEN_FREE_POOL = quotaPool('opencode-zen/free', []);

export const quota = {
  bindings: [
    // OpenCode Zen free models draw on the shared free pool; paid models draw on
    // the account balance pool. No balance endpoint is invented: the balance pool
    // is evidence-free and resolves incomplete until a real row exists.
    binding('opencode-zen', 'mimo-v2.5-free', [ZEN_FREE_POOL]),
    binding('opencode-zen', 'ling-3.0-flash-fin-free', [ZEN_FREE_POOL]),
    binding('opencode-zen', 'big-pickle', [ZEN_FREE_POOL]),
    binding('opencode-zen', 'union-alpha', [ZEN_FREE_POOL]),
    binding('opencode-zen', 'nemotron-3-ultra-free', [ZEN_FREE_POOL]),
    binding('opencode-zen', 'nemotron-3.5-lightning-free', [ZEN_FREE_POOL]),
    binding('opencode-zen', 'glm-5.3', [ZEN_BALANCE_POOL]),
    binding('opencode-zen', 'kimi-k3', [ZEN_BALANCE_POOL]),
  ],
  defaultPools: [ZEN_FREE_POOL],
} satisfies Provider['quota'];
