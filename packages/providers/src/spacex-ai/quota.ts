import type { Provider } from '../base/provider.ts';
import { quotaPool } from '../base/quota-helpers.ts';

export const quota = {
  bindings: [],
  defaultPools: [quotaPool('spacex-ai/usage', [])],
} satisfies Provider['quota'];
