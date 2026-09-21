import type { Provider } from '../base/provider.ts';
import { quotaWindow, quotaPool } from '../base/quota-helpers.ts';

const CODEX_PARSER = 'runtime/forge/internal/usage/quota/codex.go';

const CHATGPT_7D_POOL = quotaPool('chatgpt/7d', [
  quotaWindow('7d', 'full_cycle', 'provider_parser', CODEX_PARSER, '2026-09-09'),
]);

const CHATGPT_5H_POOL = quotaPool('chatgpt/5h', [
  quotaWindow('5h', 'full_cycle', 'provider_parser', CODEX_PARSER, '2026-09-09'),
]);

export const quota = {
  bindings: [],
  defaultPools: [CHATGPT_5H_POOL, CHATGPT_7D_POOL],
} satisfies Provider['quota'];
