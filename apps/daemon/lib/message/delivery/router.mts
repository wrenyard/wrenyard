import type { MessageEnvelope, MessageDeliveryRegistryConfig } from './types.mts'

export interface ResolvedDeliveryRoutes {
  routes: string[]
  errors: string[]
}

export function resolveDeliveryRoutes(
  event: MessageEnvelope,
  explicitRoutes: string[] | undefined,
  cfg: MessageDeliveryRegistryConfig
): ResolvedDeliveryRoutes {
  // cfg.channels is a legacy config key. It now behaves as the event-delivery
  // route map until external config is migrated.
  const known = new Set(Object.keys(cfg.channels))

  // undefined -> use routing rules; explicit [] -> no routed routes.
  let candidateNames: string[]
  if (explicitRoutes !== undefined) {
    if (explicitRoutes.length > 0) {
      candidateNames = explicitRoutes
    } else {
      // Explicit empty array: skip route/default fallback.
      return { routes: [], errors: [] }
    }
  } else {
    const route = cfg.routes?.[event.kind]
    if (route && route.length > 0) {
      candidateNames = route
    } else {
      candidateNames = cfg.default
    }
  }

  const routes: string[] = []
  const errors: string[] = []

  for (const name of candidateNames) {
    if (known.has(name)) {
      routes.push(name)
    } else {
      errors.push(name)
    }
  }

  return { routes, errors }
}
