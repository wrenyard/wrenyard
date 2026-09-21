import type { Provider } from '../base/provider.ts';
import { binding, quotaWindow, quotaPool } from '../base/quota-helpers.ts';

const CURSOR_PARSER = 'runtime/forge/internal/usage/quota/cursor.go';

const CURSOR_DOCS = 'https://cursor.com/docs/models-and-pricing';

const CURSOR_OTHER_POOL = quotaPool('cursor/other', [
  quotaWindow('Other', 'full_cycle', 'provider_parser', CURSOR_PARSER, '2026-09-10'),
]);

const CURSOR_POOL = quotaPool('cursor/cursor', [
  quotaWindow('Cursor', 'full_cycle', 'official_docs', CURSOR_DOCS),
]);

export const quota = {
  bindings: [
    binding('cursor', 'grok-4.6', [CURSOR_POOL]),
    binding('cursor', 'composer-2.5', [CURSOR_POOL]),
    // Third-party Cursor models consume the Other allowance, not the Cursor pool.
    binding('cursor', 'kimi-k3', [CURSOR_OTHER_POOL]),
    binding('cursor', 'claude-opus-5', [CURSOR_OTHER_POOL]),
    binding('cursor', 'gpt-5.6-luna', [CURSOR_OTHER_POOL]),
    binding('cursor', 'gpt-5.6-terra', [CURSOR_OTHER_POOL]),
    binding('cursor', 'gpt-5.6-sol', [CURSOR_OTHER_POOL]),
    binding('cursor', 'claude-sonnet-5', [CURSOR_OTHER_POOL]),
    binding('cursor', 'muse-spark-1.3', [CURSOR_OTHER_POOL]),
    binding('cursor', 'gemini-3.8-flash', [CURSOR_OTHER_POOL]),
    binding('cursor', 'claude-fable-5', [CURSOR_OTHER_POOL]),
    binding('cursor', 'claude-fable-5-1', [CURSOR_OTHER_POOL]),
  ],
  defaultPools: [quotaPool('cursor/usage', [])],
} satisfies Provider['quota'];
