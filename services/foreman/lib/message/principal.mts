/**
 * Principal identity and permission model.
 * Each principal declares its identity kind, send/receive capability, grants,
 * and optional external delivery route reference.
 */
import type { MessageRouteConfig } from './types.mts'

export type PrincipalKind = 'human' | 'agent' | 'service'

export interface PrincipalGrant {
  name: string  // e.g. 'message.send', 'work.read'
}

export interface MessagePrincipal {
  id: string
  kind: PrincipalKind
  canSend: boolean
  canReceive: boolean
  grants: PrincipalGrant[]
  deliveryRoute?: string  // route reference for external delivery only
}

export interface PrincipalRegistry {
  principals: Record<string, MessagePrincipal>
  routes?: Record<string, MessageRouteConfig>
}

/** Canonical principal definitions. */
export const CANONICAL_PRINCIPALS: Record<string, MessagePrincipal> = {
  codex: {
    id: 'codex',
    kind: 'agent',
    canSend: true,
    canReceive: false,
    grants: [{ name: 'message.send' }, { name: 'work.read' }],
  },
  opencode: {
    id: 'opencode',
    kind: 'agent',
    canSend: true,
    canReceive: false,
    grants: [{ name: 'message.send' }, { name: 'work.read' }],
  },
  pet: {
    id: 'pet',
    kind: 'service',
    canSend: false,
    canReceive: true,
    grants: [],
  },
  'foreman-work': {
    id: 'foreman-work',
    kind: 'service',
    canSend: true,
    canReceive: true,
    grants: [{ name: 'message.send' }, { name: 'work.read' }],
  },
}

/** Errors returned by principal validation. */
export const PRINCIPAL_ERRORS = {
  not_addressable: 'not_addressable',
  unknown_principal: 'unknown_principal',
  forbidden: 'forbidden',
  unknown_agent_address: 'unknown_agent_address',
} as const

export type PrincipalErrorCode = typeof PRINCIPAL_ERRORS[keyof typeof PRINCIPAL_ERRORS]

export interface PrincipalError {
  error: PrincipalErrorCode
  message?: string
}

export function validateSender(
  registry: PrincipalRegistry,
  senderId: string,
): PrincipalError | null {
  const principal = registry.principals[senderId]
  if (!principal) {
    return { error: PRINCIPAL_ERRORS.unknown_principal, message: `unknown principal: ${senderId}` }
  }
  if (!principal.canSend) {
    return { error: PRINCIPAL_ERRORS.forbidden, message: `principal '${senderId}' is not authorized to send messages` }
  }
  if (!principal.grants.some((g) => g.name === 'message.send')) {
    return { error: PRINCIPAL_ERRORS.forbidden, message: `principal '${senderId}' lacks message.send grant` }
  }
  return null
}

export function validateRecipient(
  registry: PrincipalRegistry,
  recipientId: string,
): PrincipalError | null {
  const principal = registry.principals[recipientId]
  if (!principal) {
    return { error: PRINCIPAL_ERRORS.unknown_principal, message: `unknown principal: ${recipientId}` }
  }
  if (!principal.canReceive) {
    return { error: PRINCIPAL_ERRORS.not_addressable, message: `principal '${recipientId}' is not addressable (cannot receive)` }
  }
  return null
}

export function hasGrant(
  principal: MessagePrincipal,
  grantName: string,
): boolean {
  return principal.grants.some((g) => g.name === grantName)
}

export function resolvePrincipalDeliveryRoute(
  registry: PrincipalRegistry,
  principalId: string,
): MessageRouteConfig | null {
  const principal = registry.principals[principalId]
  if (!principal?.deliveryRoute) return null
  const routes = registry.routes ?? {}
  return routes[principal.deliveryRoute] ?? null
}
