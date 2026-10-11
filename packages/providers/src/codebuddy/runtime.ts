import type { ProviderDefinition } from '../base/index.ts';
import { resolveCodeBuddyProductModelId, type CodeBuddyModels } from './models.ts';
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
  /**
   * The startup account read once by the composition root. When a loadAccount
   * loader is supplied to createCodeBuddyRuntime this is only the initial and
   * fallback value; otherwise it is the account every read resolves to.
   */
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
   * Reverse an observed wire spelling onto the offering it names. The
   * provider's published alias map is consulted first (current wire ids plus
   * historical spellings); when it does not cover the id, the product-id
   * resolver maps retired Claude generation-5 spellings onto their historical
   * identity without ever making them routable again.
   */
  function canonicalizeCodeBuddyObservedModelId(model: string): string {
    return state.definition.modelAliases?.[model] ?? resolveCodeBuddyProductModelId(model) ?? model;
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

type CodeBuddyProviderAccount = NonNullable<CodeBuddyProviderProduct['account']>;

export function createCodeBuddyRuntime(
  product: CodeBuddyProviderProduct | undefined,
  state: CodeBuddyModels,
  loadAccount?: () => Promise<CodeBuddyProviderProduct['account'] | undefined>,
) {
  const routing = createModelRouting(state);
  const ready = product?.status === 'ready' ? product : undefined;
  const environment = ready?.environment ?? 'unknown';
  const environments = new WeakMap<CodeBuddyCredential, CodeBuddyEnvironment>();
  // The last resolved credential/account pair. It starts from the product
  // snapshot account and is refreshed by the loader; a loader failure keeps the
  // last good pair so a transient unreadable auth file never drops a signed-in
  // credential.
  let last: { credential: CodeBuddyCredential; account: CodeBuddyProviderAccount } | undefined;
  function bind(account: CodeBuddyProviderAccount): { credential: CodeBuddyCredential; account: CodeBuddyProviderAccount } {
    // Credential object identity tracks the token value: an unchanged token
    // reuses the exact frozen object (and its registered environment) while
    // still rebinding account.headers onto it, a rotated token mints a new one.
    if (last && last.credential.value === account.accessToken) {
      if (account.headers) codeBuddyNativeHeaders.set(last.credential, account.headers);
      return { credential: last.credential, account };
    }
    const credential = Object.freeze({ value: account.accessToken });
    environments.set(credential, environment);
    if (account.headers) codeBuddyNativeHeaders.set(credential, account.headers);
    return { credential, account };
  }
  const startupAccount = ready?.account;
  if (startupAccount?.accessToken) last = bind(startupAccount);
  /**
   * Resolve the current account on every call. With no loader the startup
   * account is used; with a loader a rotated token is picked up immediately, a
   * loader error keeps the last resolved pair, and an undefined/empty result
   * clears the remembered pair so a later loader error cannot fall back to a
   * signed-out account's old token.
   */
  async function current(): Promise<{ credential: CodeBuddyCredential; account: CodeBuddyProviderAccount } | undefined> {
    if (!ready) return undefined;
    if (!loadAccount) return last;
    let account: CodeBuddyProviderProduct['account'];
    try {
      account = await loadAccount();
    } catch {
      return last;
    }
    if (!account?.accessToken) {
      last = undefined;
      return undefined;
    }
    last = bind(account);
    return last;
  }

  return {
    canonicalizeModel: routing.canonicalizeCodeBuddyObservedModelId,
    async credential(): Promise<CodeBuddyCredential | undefined> {
      return (await current())?.credential;
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
      const resolved = await current();
      if (!resolved) return undefined;
      return freezeCodeBuddyActiveSnapshot(resolved.credential, environment, resolved.account.stableScope, routing);
    },
    async clientIdentity(): Promise<CodeBuddyClientIdentity | undefined> {
      return ready?.identity;
    },
  };
}
