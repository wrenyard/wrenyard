import type { Provider } from '../base/provider.ts';
import { quotaPool } from '../base/quota-helpers.ts';

export const quota = {
  bindings: [],
  defaultPools: [quotaPool('claude-coding/usage', [])],
} satisfies Provider['quota'];
