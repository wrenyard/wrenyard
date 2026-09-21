import type { Provider } from '../base/provider.ts';
import { quotaPool } from '../base/quota-helpers.ts';

export const quota = {
  bindings: [],
  defaultPools: [quotaPool('opencode-go/usage', [])],
} satisfies Provider['quota'];
