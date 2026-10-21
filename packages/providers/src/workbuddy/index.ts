import type { Provider, ProviderContext } from '../base/index.ts';
import type { WorkBuddyBuild, WorkBuddyBuildId } from './definition.ts';
import { WORKBUDDY_BUILDS } from './definition.ts';
import { defaultProviderContext, type WorkBuddyAccountIdentity } from './credentials.ts';
import { createWorkBuddyModelState } from './models.ts';
import { createWorkBuddyQuota } from './quota.ts';
import { createWorkBuddyRuntime } from './runtime.ts';

export interface WorkBuddyOptions {
  readonly context?: ProviderContext;
  readonly fetch?: typeof fetch;
}

export interface WorkBuddyProvider extends Provider {
  refreshModels(): Promise<void>;
  refreshCredential(credential: import('../base/provider.ts').ProviderCredential, signal: AbortSignal): Promise<import('../base/provider.ts').ProviderCredential>;
  /** Verified login identity of the newest read; undefined before the first one. */
  accountIdentity(): WorkBuddyAccountIdentity | undefined;
  /** Explicit account switch: drop every cache derived from the previous login. */
  resetAccount(): void;
}

/** Every WorkBuddy build id, for daemon routing that rebinds their pools. */
export const WORKBUDDY_PROVIDER_IDS: readonly string[] = Object.freeze(WORKBUDDY_BUILDS.map((build) => build.id));

const sharedModelStates = new Map<WorkBuddyBuildId, ReturnType<typeof createWorkBuddyModelState>>();

export function createWorkBuddyProvider(build: WorkBuddyBuild, options: WorkBuddyOptions = {}): WorkBuddyProvider {
  const context = options.context ?? defaultProviderContext();
  let state = sharedModelStates.get(build.id);
  if (!state) {
    state = createWorkBuddyModelState(build);
    sharedModelStates.set(build.id, state);
  }
  const runtime = createWorkBuddyRuntime({
    store: { context, build },
    state,
    fetch: options.fetch,
  });
  const definition = state.definition;
  definition.beforeRequest = (hookContext) => runtime.beforeRequest(hookContext);
  definition.afterResponse = (hookContext) => runtime.afterResponse(hookContext);
  const quota = createWorkBuddyQuota(definition, () => runtime.readQuotaObservation(), () => runtime.accountIdentity());
  return {
    id: build.id,
    definition,
    clients: [],
    quota,
    credential: () => runtime.credential(),
    refreshCredential: (credential, signal) => runtime.refreshCredential(credential, signal),
    resolveModel: (model) => runtime.resolveUpstreamModel(model),
    canonicalizeModel: (model) => runtime.canonicalizeModel(model),
    applyHeaders: (headers, credential, protocol) => runtime.applyHeaders(headers, credential, protocol),
    freeSupply: (model, credential) => runtime.freeSupply(model, credential),
    refreshModels: () => runtime.refreshModels(),
    accountIdentity: () => runtime.accountIdentity(),
    resetAccount: () => runtime.resetAccount(),
  };
}

export function createWorkBuddyProviders(options: WorkBuddyOptions = {}): readonly [WorkBuddyProvider, WorkBuddyProvider] {
  return [createWorkBuddyProvider(WORKBUDDY_BUILDS[0], options), createWorkBuddyProvider(WORKBUDDY_BUILDS[1], options)];
}

export { WORKBUDDY_BUILDS, WORKBUDDY_CN, WORKBUDDY_INTL } from './definition.ts';
export { workBuddyPoolsForModel } from './quota.ts';
export type { WorkBuddyAccountIdentity } from './credentials.ts';
export type { WorkBuddyAccountKind } from './credentials.ts';
