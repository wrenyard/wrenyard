/**
 * Provider id renames whose persisted credential-store entries must keep
 * resolving after the rename. Only the exact legacy id is rewritten, and only
 * for a store entry that is an API key (`type: 'api'`): a subscription OAuth
 * entry is never promoted to an API key, and the modern `anthropic` provider
 * means the API provider on every read. New writes always use the canonical id.
 */
export const legacyCredentialStoreIds: Readonly<Record<string, string>> = {
  'anthropic-api': 'anthropic',
};

