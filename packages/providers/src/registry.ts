import { Catalog } from '@wrenyard/catalog';
import { BUILTIN_CLIENTS, BUILTIN_PROVIDERS } from './catalog.ts';

/** Registers every built-in client and provider into a fresh catalog. */
export function createBuiltinCatalog(): Catalog {
  const catalog = new Catalog();
  for (const client of BUILTIN_CLIENTS) catalog.registerClient(client);
  for (const provider of BUILTIN_PROVIDERS) catalog.registerProvider(provider);
  return catalog;
}

export { BUILTIN_CLIENTS, BUILTIN_PROVIDERS };
