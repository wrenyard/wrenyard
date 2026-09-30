import type { Provider } from '../base/provider.ts';
import { binding, quotaPool, balancePool } from '../base/quota-helpers.ts';

const OPENROUTER_FREE_POOL = quotaPool('openrouter/free', []);
const OPENROUTER_BALANCE_POOL = balancePool('openrouter/balance', '');

export const quota = {
  bindings: [
    binding('openrouter', 'anthropic/claude-sonnet-5.5', [OPENROUTER_BALANCE_POOL]),
    binding('openrouter', 'openai/gpt-6.1-sol', [OPENROUTER_BALANCE_POOL]),
  ],
  defaultPools: [OPENROUTER_FREE_POOL],
} satisfies Provider['quota'];
