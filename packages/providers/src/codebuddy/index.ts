import type { Provider } from '../base/index.ts';
import { codeBuddyClient, createCodeBuddyModels } from './models.ts';
import type { CodeBuddyProductModelEntry } from './product.ts';
import { applyCodeBuddyNativeHeaders, createCodeBuddyRuntime, type CodeBuddyActiveSnapshot, type CodeBuddyClientIdentity, type CodeBuddyProviderProduct } from './runtime.ts';
import { createCodeBuddyQuota } from './quota.ts';

export interface CodeBuddyOptions {
  /** Explicit product and account snapshot. Absent means no install was supplied. */
  product?: CodeBuddyProviderProduct;
  /** @deprecated Prefer product.entries. Kept so callers can pass an already parsed model list. */
  productModels?: readonly CodeBuddyProductModelEntry[];
}

export interface CodeBuddy extends Provider {
  snapshot(): Promise<CodeBuddyActiveSnapshot | undefined>;
  clientIdentity(): Promise<CodeBuddyClientIdentity | undefined>;
}

/** Build a CodeBuddy provider from an injected snapshot. Does not search the machine. */
export function createCodeBuddy(options: CodeBuddyOptions = {}): CodeBuddy {
  const product = options.product ?? (options.productModels
    ? { status: 'ready' as const, environment: 'unknown' as const, entries: options.productModels }
    : undefined);
  const entries = product?.status === 'ready' ? product.entries : [];
  const state = createCodeBuddyModels(entries);
  const runtime = createCodeBuddyRuntime(product, state);
  return {
    id: state.definition.id,
    definition: state.definition,
    clients: [codeBuddyClient],
    quota: createCodeBuddyQuota(state.definition),
    credential: runtime.credential,
    resolveModel: (model, credential) => runtime.resolveUpstreamModel(model, credential) ?? model,
    canonicalizeModel: runtime.canonicalizeModel,
    applyHeaders: (headers, credential, protocol) => applyCodeBuddyNativeHeaders(headers, state.definition, credential, protocol),
    freeSupply: runtime.freeSupply,
    snapshot: runtime.snapshot,
    clientIdentity: runtime.clientIdentity,
  };
}

export type { CodeBuddyActiveSnapshot, CodeBuddyClientIdentity, CodeBuddyCredential, CodeBuddyEnvironment, CodeBuddyProviderProduct } from './runtime.ts';
