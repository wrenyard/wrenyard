import type { Provider } from '../base/provider.ts';
import { balancePool } from '../base/quota-helpers.ts';

export const quota = {
  bindings: [],
  defaultPools: [balancePool('openai/balance', '')],
} satisfies Provider['quota'];
