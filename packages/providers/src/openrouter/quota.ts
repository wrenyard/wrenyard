import type { Provider } from '../base/provider.ts';
import { quotaPool } from '../base/quota-helpers.ts';

const OPENROUTER_FREE_POOL = quotaPool('openrouter/free', []);

export const quota = {
  bindings: [],
  defaultPools: [OPENROUTER_FREE_POOL],
} satisfies Provider['quota'];
