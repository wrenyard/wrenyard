import { CodeBuddyClient, type InspectOptions } from '@wrenyard/clients';
import { createBuiltinCatalog, createCodeBuddy } from '@wrenyard/providers';

let catalog = createBuiltinCatalog();
let pending: Promise<void> | undefined;

/** Load the shared CodeBuddy product snapshot before catalog readers run. */
export function refreshDesktopCatalog(): Promise<void> {
    pending ??= composeDesktopCatalog().then((composed) => {
        catalog = composed;
    });
    return pending;
}

export function desktopCatalog() {
    return catalog;
}

/**
 * Build the Desktop catalog from one CodeBuddy install read. The same read
 * supplies both the public product facts and the private account context the
 * CodeBuddy provider binds to its credential.
 */
async function composeDesktopCatalog(options?: InspectOptions) {
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
