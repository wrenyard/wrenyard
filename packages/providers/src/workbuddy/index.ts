import type { Provider, ProviderContext } from '../base/index.ts';
import type { WorkBuddyBuild } from './definition.ts';
import { WORKBUDDY_BUILDS } from './definition.ts';
import { defaultProviderContext } from './credentials.ts';
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
}

export function createWorkBuddyProvider(build: WorkBuddyBuild, options: WorkBuddyOptions = {}): WorkBuddyProvider {
  const context = options.context ?? defaultProviderContext();
  const state = createWorkBuddyModelState(build);
  const runtime = createWorkBuddyRuntime({
    store: { context, build },
    state,
    fetch: options.fetch,
  });
  const definition = state.definition;
  definition.beforeRequest = (hookContext) => runtime.beforeRequest(hookContext);
  definition.afterResponse = (hookContext) => runtime.afterResponse(hookContext);
  const quota = createWorkBuddyQuota(definition);
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
  };
}

export function createWorkBuddyProviders(options: WorkBuddyOptions = {}): readonly [WorkBuddyProvider, WorkBuddyProvider] {
  return [createWorkBuddyProvider(WORKBUDDY_BUILDS[0], options), createWorkBuddyProvider(WORKBUDDY_BUILDS[1], options)];
}

export { WORKBUDDY_BUILDS, WORKBUDDY_CN, WORKBUDDY_INTL } from './definition.ts';
