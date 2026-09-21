import type { Provider } from '../base/provider.ts';
import { binding, balancePool } from '../base/quota-helpers.ts';

const DEEPSEEK_PARSER = 'runtime/forge/internal/usage/quota/deepseek.go';

export const quota = {
  bindings: [
    // Official deepseek pool: the official `deepseek` provider row carries a
    // mandatory monetary balance resource (`deepseek/balance`) for every model it
    // serves, including deepseek-flash. It deliberately inherits NO CodeBuddy or
    // TokenHub balance: a missing/stale/unknown amount keeps coverage incomplete
    // rather than fabricating a balance.
    binding('deepseek', 'deepseek-flash', [balancePool('deepseek/balance', DEEPSEEK_PARSER)]),
    binding('deepseek', 'deepseek-pro', [balancePool('deepseek/balance', DEEPSEEK_PARSER)]),
  ],
  defaultPools: [balancePool('deepseek/balance', DEEPSEEK_PARSER)],
} satisfies Provider['quota'];
