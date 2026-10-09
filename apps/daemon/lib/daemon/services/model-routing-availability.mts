import type { Catalog } from '@wrenyard/providers/catalog';
import type { ProviderRuntime } from '@wrenyard/providers';
import type { TaskSettingsRuntimeAvailabilityCallback } from './task-settings-service.mts';
import type { CodeBuddyActiveSnapshotView } from './auto-routing-snapshot-service.mts';
import { evaluateNativeRouteReadiness, type NativeProviderReadinessSnapshot } from '../execution/native-provider-readiness.mts';

/** Existing Task readiness policy, shared without changing native/Gateway admission. */
export function createRoutingAvailability(options: {
  catalog: Catalog; providerRuntime: ProviderRuntime;
  loadNativeProviderReadiness: () => Promise<NativeProviderReadinessSnapshot>;
  loadCurrentCodeBuddySnapshot: () => Promise<CodeBuddyActiveSnapshotView | undefined>;
}): TaskSettingsRuntimeAvailabilityCallback {
  const { catalog, providerRuntime, loadNativeProviderReadiness, loadCurrentCodeBuddySnapshot } = options;
  return async ({ client, provider, model, mode }, availabilityContext) => {
      const providerDef = catalog.provider(provider)
      if (!providerDef) {
        return {
          providerCredential: 'unknown',
          providerLive: 'unknown',
          quota: 'unknown',
          available: false,
        }
      }
      if (providerDef.credentialResolver === 'codex' || providerDef.credentialResolver === 'cursor') {
        // A request-bound automatic context contains the one status sample for
        // that evaluation (null means its bounded query failed). Explicit-mode
        // checks have no context and take one fresh sample here. In either case
        // the actual native runtime remains the credential authority and
        // revalidates the login when execution starts.
        let readiness = availabilityContext?.nativeProviderReadiness ?? undefined
        if (availabilityContext === undefined) {
          try {
            readiness = await loadNativeProviderReadiness()
          } catch {
            readiness = undefined
          }
        }
        const state = evaluateNativeRouteReadiness(readiness, {
          providerId: providerDef.id,
          client,
          mode,
          nativeClients: providerDef.nativeClients ?? [],
          model,
        })
        if (state === 'available') {
          return {
            providerCredential: 'available',
            providerLive: 'available',
            quota: 'unknown',
            available: true,
          }
        }
        if (state === 'missing') {
          return {
            providerCredential: 'missing',
            providerLive: 'unknown',
            quota: 'unknown',
            available: false,
          }
        }
        if (state === 'blocked') {
          return {
            providerCredential: 'available',
            providerLive: 'unavailable',
            quota: 'unknown',
            available: false,
          }
        }
        return {
          providerCredential: 'unknown',
          providerLive: state === 'unsupported' ? 'unavailable' : 'unknown',
          quota: 'unknown',
          available: false,
        }
      }
      if (providerDef.id === 'codebuddy') {
        // Exact codebuddy readiness uses exactly one fresh immutable
        // CodeBuddyActiveSnapshot for the current login/environment. Absent or
        // throwing loads and snapshots without an opaque stable scope fail
        // closed (reported missing); confirmed-free is derived only through
        // that same snapshot.freeSupply(model). There is no fallback to
        // credential()/freeSupply(), and no credential, stable scope,
        // environment, domain, token, or wire model is exposed on the report.
        let activeSnapshot = availabilityContext?.codeBuddySnapshot
        if (availabilityContext === undefined) {
          try {
            activeSnapshot = await loadCurrentCodeBuddySnapshot()
          } catch {
            activeSnapshot = undefined
          }
        }
        if (activeSnapshot === undefined || activeSnapshot.stableScope === undefined) {
          return {
            providerCredential: 'missing',
            providerLive: 'unknown',
            quota: 'unknown',
            available: false,
          }
        }
        const wireModel = activeSnapshot.resolveUpstreamModel(model)
        if (!wireModel) {
          return {
            providerCredential: 'missing',
            providerLive: 'unknown',
            quota: 'unknown',
            available: false,
          }
        }
        const freeSupply = activeSnapshot.freeSupply(model)
        // An iOA login exposes no observable quota pool, so the generic
        // unknown-quota outcome would rank it as if it were exhausted. The
        // environment classification stays inside this branch; only a derived
        // provenance-bearing fact leaves it.
        const quotaFloor = activeSnapshot.environment === 'ioa'
          ? { source: 'codebuddy.credential_environment', ruleId: 'codebuddy.ioa_unknown_quota_floor' }
          : undefined
        return {
          providerCredential: 'available',
          providerLive: 'available',
          quota: 'unknown',
          available: true,
          ...(freeSupply ? { freeSupply } : {}),
          ...(quotaFloor ? { quotaFloor } : {}),
          codeBuddyExecution: {
            expectedScope: activeSnapshot.stableScope,
            expectedEnvironment: activeSnapshot.environment,
            expectedWireModel: wireModel,
          },
        }
      }
      const credential = await providerRuntime.credential(providerDef)
      const available = credential !== undefined
      const freeSupply = credential === undefined
        ? undefined
        : providerRuntime.freeSupply?.(providerDef, model, credential)
      return {
        providerCredential: available ? 'available' : 'missing',
        providerLive: available ? 'available' : 'unknown',
        quota: 'unknown',
        available,
        ...(freeSupply ? { freeSupply } : {}),
      }
    }
}

/** Auxiliary calls use Gateway credentials even for a native-capable provider. */
export function createAuxiliaryAvailability(base: TaskSettingsRuntimeAvailabilityCallback, catalog: Catalog, providerRuntime: ProviderRuntime): TaskSettingsRuntimeAvailabilityCallback {
  return async (target, context) => {
    const provider = catalog.provider(target.provider);
    if (provider?.credentialResolver === 'codex') {
      const credential = await providerRuntime.credential(provider);
      const available = credential !== undefined;
      return { providerCredential: available ? 'available' : 'missing', providerLive: available ? 'available' : 'unknown', quota: 'unknown', available };
    }
    return base(target, context);
  };
}
