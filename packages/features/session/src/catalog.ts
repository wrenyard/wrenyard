import { CodeBuddyClient, type InspectOptions } from '@wrenyard/clients';
import { createBuiltinCatalog, createCodeBuddy } from '@wrenyard/providers';

/**
 * The feature's authoritative built-in Catalog.
 *
 * It is read only to resolve exact product facts already projected into the
 * conversation directory — a model's canonical identity or its input
 * capabilities — never to enumerate, re-merge, or fabricate models. The
 * fallback instance is usable before any refresh, so importing this module
 * never requires a CodeBuddy install to be present.
 */
let catalog = createBuiltinCatalog();
let pending: Promise<void> | undefined;

/** Load the shared CodeBuddy product snapshot before catalog readers run. */
export function refreshCatalog(): Promise<void> {
  pending ??= composeCatalog().then((composed) => {
    catalog = composed;
  });
  return pending;
}

export function builtinCatalog() {
  return catalog;
}

/**
 * Build the Catalog from one CodeBuddy install read. The same read supplies
 * both the public product facts and the private account context the CodeBuddy
 * provider binds to its credential.
 */
async function composeCatalog(options?: InspectOptions) {
  const install = await new CodeBuddyClient().readInstall(options);
  const codeBuddy = createCodeBuddy({
    product: {
      status: install.product.status,
      environment: install.product.environment,
      entries: install.product.entries,
      ...(install.product.identity ? { identity: install.product.identity } : {}),
      ...(install.account ? { account: install.account } : {}),
    },
  });
  return createBuiltinCatalog([codeBuddy]);
}
