import { Catalog } from './base/catalog.ts';
import type { Provider } from './base/index.ts';
import { BUILTIN_CLIENTS, BUILTIN_PROVIDERS } from './catalog.ts';

/** Registers every built-in client and provider into a fresh catalog. */
export function createBuiltinCatalog(implementations: readonly Provider[] = []): Catalog {
  const catalog = new Catalog();
  const clients = new Map(BUILTIN_CLIENTS.map((client) => [client.id, client]));
  const providers = new Map(BUILTIN_PROVIDERS.map((provider) => [provider.id, provider]));
  for (const implementation of implementations) {
    providers.set(implementation.id, implementation.definition);
    for (const client of implementation.clients) clients.set(client.id, client);
  }
  for (const client of clients.values()) catalog.registerClient(client);
  for (const provider of providers.values()) catalog.registerProvider(provider);
  return catalog;
}

export { BUILTIN_CLIENTS, BUILTIN_PROVIDERS };
