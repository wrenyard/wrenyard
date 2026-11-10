import type { Provider } from '../base/index.ts';
import { codeBuddyClient, createCodeBuddyModels } from './models.ts';
import type { CodeBuddyProductModelEntry } from './product.ts';
import { applyCodeBuddyNativeHeaders, createCodeBuddyRuntime, type CodeBuddyActiveSnapshot, type CodeBuddyClientIdentity, type CodeBuddyEnvironment, type CodeBuddyProviderProduct } from './runtime.ts';
import { createCodeBuddyQuota } from './quota.ts';
export { codeBuddyPoolsForModel } from './quota.ts';

export interface CodeBuddyOptions {
  /** Explicit product and account snapshot. Absent means no install was supplied. */
  product?: CodeBuddyProviderProduct;
  /** @deprecated Prefer product.entries. Kept so callers can pass an already parsed model list. */
  productModels?: readonly CodeBuddyProductModelEntry[];
  /**
   * Loader of the current signed-in account, called on every credential read so
   * a rotated token is picked up without restarting. Absent means the product
   * snapshot account is used.
   */
  account?: (environment: CodeBuddyEnvironment) => Promise<CodeBuddyProviderProduct['account'] | undefined>;
  /**
   * Re-runs full installation/account/environment/model discovery; called by
   * refreshModels(). Absent means discovery cannot be re-run.
   */
  discover?: () => Promise<CodeBuddyProviderProduct | undefined>;
}

export interface CodeBuddy extends Provider {
  snapshot(): Promise<CodeBuddyActiveSnapshot | undefined>;
  clientIdentity(): Promise<CodeBuddyClientIdentity | undefined>;
  /** Re-run discovery and republish catalog/runtime state coherently. */
  refreshModels(): Promise<void>;
  /** Safe discovery status/reason, distinct from credential and route state. */
  discovery(): { status: 'ready' | 'unavailable'; reason?: string };
}

/** Build a CodeBuddy provider from an injected snapshot. Does not search the machine. */
export function createCodeBuddy(options: CodeBuddyOptions = {}): CodeBuddy {
  const product = options.product ?? (options.productModels
    ? { status: 'ready' as const, environment: 'unknown' as const, entries: options.productModels }
    : undefined);
  const entries = product?.status === 'ready' ? product.entries : [];
  const state = createCodeBuddyModels(entries, product?.status === 'ready' ? product.environment : 'unknown');
  const runtime = createCodeBuddyRuntime(product, state, options.account, options.discover);
  // The supplier request/response hooks (client identity, per-turn round cache,
  // private-error correction) are part of the registered definition, so the
  // Gateway executes them generically without any CodeBuddy branch of its own.
  const definition = Object.assign(state.definition, {
    beforeRequest: (context: Parameters<typeof runtime.beforeRequest>[0]) => runtime.beforeRequest(context),
    afterResponse: (context: Parameters<typeof runtime.afterResponse>[0]) => runtime.afterResponse(context),
  });
  return {
    id: definition.id,
    definition,
    clients: [codeBuddyClient],
    quota: createCodeBuddyQuota(definition),
    credential: runtime.credential,
    resolveModel: (model, credential) => runtime.resolveUpstreamModel(model, credential) ?? model,
    canonicalizeModel: runtime.canonicalizeModel,
    applyHeaders: (headers, credential, protocol) => applyCodeBuddyNativeHeaders(headers, state.definition, credential, protocol),
    freeSupply: runtime.freeSupply,
    snapshot: runtime.snapshot,
    clientIdentity: runtime.clientIdentity,
    refreshModels: runtime.refresh,
    discovery: runtime.discovery,
  };
}

export type { CodeBuddyActiveSnapshot, CodeBuddyClientIdentity, CodeBuddyCredential, CodeBuddyEnvironment, CodeBuddyProviderProduct } from './runtime.ts';
