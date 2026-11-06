import type { Catalog, DispatchPlan, ReasoningEffort, RunSyntaxRef } from '@wrenyard/providers/catalog'

/** The hardcoded provider identity used for workers on a configured endpoint. */
export const WRENYARD_PROVIDER = 'wrenyard'

/**
 * Build the launch plan for one resolved run target. A worker on the configured
 * endpoint is the `wrenyard` provider: it is a directly built gateway plan over
 * Chat and never passes through the built-in catalog. Every other provider is
 * resolved through the catalog exactly as before.
 */
export function resolvePlan(
  catalog: Catalog,
  target: RunSyntaxRef,
  reasoningEffort?: ReasoningEffort,
  fast?: boolean,
): DispatchPlan {
  if (target.provider === WRENYARD_PROVIDER) {
    return {
      ...target,
      mode: 'gateway',
      protocol: 'openai_chat',
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    }
  }
  return catalog.resolveRun(target.client, target.provider, target.model, reasoningEffort, fast)
}
