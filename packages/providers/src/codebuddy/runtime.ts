import type { ProviderDefinition } from '../base/index.ts';
import type { CodeBuddyModels } from './models.ts';
import type { CodeBuddyEnvironment, CodeBuddyProductModelEntry } from './product.ts';

export type { CodeBuddyEnvironment };

export interface CodeBuddyClientIdentity {
  readonly platform: string;
  readonly productName: string;
  readonly version: string;
  readonly deploymentType: string;
}

export interface CodeBuddyCredential {
  value: string;
}

export interface CodeBuddyFreeSupplyFact {
  readonly confirmedFree: true
  readonly source: string
  readonly ruleId: string
}

export interface CodeBuddyActiveSnapshot {
  readonly provider: 'codebuddy'
  readonly credential: CodeBuddyCredential
  readonly environment: CodeBuddyEnvironment
  readonly stableScope: string | undefined
  resolveUpstreamModel(model: string): string
  freeSupply(model: string): CodeBuddyFreeSupplyFact | undefined
}

/** Product and account facts supplied by the composition root. This module does not read the install. */
export interface CodeBuddyProviderProduct {
  readonly status: 'ready' | 'unavailable';
  readonly environment: CodeBuddyEnvironment;
  readonly entries: readonly CodeBuddyProductModelEntry[];
  readonly identity?: CodeBuddyClientIdentity;
  readonly account?: {
    readonly accessToken: string;
    readonly domain?: string;
    readonly stableScope?: string;
    readonly headers?: Readonly<Record<string, string>>;
  };
}

function createModelRouting(state: CodeBuddyModels) {
  /**
   * The exact spelling the installed product file declares for a canonical
   * offering. The mapping is fixed by the selected product entries, never by
   * the active environment or credential: a real product row is by itself
   * evidence for the wire spelling, so it applies to native dispatch, gateway
   * dispatch and observed-id normalization alike, and an unlisted id is
   * identity.
   */
  function codeBuddyUpstreamWireModel(model: string): string {
    return state.upstreamModels[model] ?? model;
  }

  /**
   * Reverse an observed wire spelling onto the offering it names. This reads
   * the provider's published alias map (current wire ids plus historical
   * spellings) rather than the outbound map, so a retired spelling normalizes
   * without ever becoming routable again.
   */
  function canonicalizeCodeBuddyObservedModelId(model: string): string {
    return state.definition.modelAliases?.[model] ?? model;
  }

  function evaluateCodeBuddyFreeSupply(
    environment: CodeBuddyEnvironment | undefined,
    model: string,
  ): CodeBuddyFreeSupplyFact | undefined {
    if (environment !== 'ioa') return undefined;
    const wireModel = codeBuddyUpstreamWireModel(model);
    const definition = state.definition.models.find((entry) => codeBuddyUpstreamWireModel(entry.id) === wireModel);
    if (definition?.free !== true) return undefined;
    return {
      confirmedFree: true,
      source: 'codebuddy.credential_environment',
      ruleId: 'codebuddy.verified_hy_model_confirmed_free',
    };
  }

  return { codeBuddyUpstreamWireModel, evaluateCodeBuddyFreeSupply, canonicalizeCodeBuddyObservedModelId };
}

const codeBuddyNativeHeaders = new WeakMap<CodeBuddyCredential, Readonly<Record<string, string>>>();
const CODEBUDDY_NATIVE_HEADER_NAMES = ['X-User-Id', 'X-Enterprise-Id', 'X-Tenant-Id', 'X-Domain'] as const;

function freezeCodeBuddyActiveSnapshot(
  credential: CodeBuddyCredential,
  environment: CodeBuddyEnvironment,
  stableScope: string | undefined,
  routing: ReturnType<typeof createModelRouting>,
): CodeBuddyActiveSnapshot {
  const frozenCredential = Object.freeze(credential);
  return Object.freeze({
    provider: 'codebuddy',
    credential: frozenCredential,
    environment,
    stableScope,
    resolveUpstreamModel(model: string): string {
      return routing.codeBuddyUpstreamWireModel(model);
    },
    freeSupply(model: string): CodeBuddyFreeSupplyFact | undefined {
      return routing.evaluateCodeBuddyFreeSupply(environment, model);
    },
  });
}

export function applyCodeBuddyNativeHeaders(
  headers: Headers,
  provider: Pick<ProviderDefinition, 'id' | 'credentialResolver'>,
  credential: CodeBuddyCredential,
  protocol: string,
): void {
  if (provider.id !== 'codebuddy' || provider.credentialResolver !== 'codebuddy' || protocol !== 'openai_chat') return;
  const nativeHeaders = codeBuddyNativeHeaders.get(credential);
  if (!nativeHeaders) return;
  for (const name of CODEBUDDY_NATIVE_HEADER_NAMES) {
    const value = nativeHeaders[name];
    if (value !== undefined) headers.set(name, value);
  }
}

export function createCodeBuddyRuntime(product: CodeBuddyProviderProduct | undefined, state: CodeBuddyModels) {
  const routing = createModelRouting(state);
  const ready = product?.status === 'ready' ? product : undefined;
  const environment = ready?.environment ?? 'unknown';
  const account = ready?.account;
  const credential = account?.accessToken ? Object.freeze({ value: account.accessToken }) : undefined;
  const environments = new WeakMap<CodeBuddyCredential, CodeBuddyEnvironment>();
  if (credential) {
    environments.set(credential, environment);
    if (account?.headers) codeBuddyNativeHeaders.set(credential, account.headers);
  }

  return {
    canonicalizeModel: routing.canonicalizeCodeBuddyObservedModelId,
    async credential(): Promise<CodeBuddyCredential | undefined> {
      return credential;
    },
    /**
     * Canonical offering -> the exact product-file wire spelling. The mapping
     * depends only on the selected product entries, so it holds with or without
     * a bound credential (matching the Kimi Coding wire-alias contract) and is
     * what a native CodeBuddy launch must pass to the CLI `--model`.
     */
    resolveUpstreamModel(model: string, _bound?: CodeBuddyCredential): string | undefined {
      return routing.codeBuddyUpstreamWireModel(model);
    },
    freeSupply(model: string, bound: CodeBuddyCredential): CodeBuddyFreeSupplyFact | undefined {
      return routing.evaluateCodeBuddyFreeSupply(environments.get(bound), model);
    },
    async snapshot(): Promise<CodeBuddyActiveSnapshot | undefined> {
      if (!credential) return undefined;
      return freezeCodeBuddyActiveSnapshot(credential, environment, account?.stableScope, routing);
    },
    async clientIdentity(): Promise<CodeBuddyClientIdentity | undefined> {
      return ready?.identity;
    },
  };
}
