/**
 * FWA address mapping: strict bijection between storage IDs and message addresses.
 *
 *   session id:  fwa_<24 lowercase hex>
 *   address:     fwa-<24 lowercase hex>
 */

const FWA_ADDRESS_REGEX = /^fwa-[0-9a-f]{24}$/
const FWA_SESSION_ID_REGEX = /^fwa_[0-9a-f]{24}$/

export function sessionIdToAddress(sessionId: string): string {
  if (!FWA_SESSION_ID_REGEX.test(sessionId)) {
    throw new Error(`invalid session id format: ${sessionId}`)
  }
  return sessionId.replace(/^fwa_/, 'fwa-')
}

export function addressToSessionId(address: string): string | null {
  if (!FWA_ADDRESS_REGEX.test(address)) return null
  return address.replace(/^fwa-/, 'fwa_')
}

export function isFwaAddress(address: string): boolean {
  return FWA_ADDRESS_REGEX.test(address)
}

export function isFwaSessionId(id: string): boolean {
  return FWA_SESSION_ID_REGEX.test(id)
}

/** Validate and convert an FWA address to a session id, or return null. */
export function resolveFwaAddress(address: string): string | null {
  return addressToSessionId(address)
}

export const FOREMAN_WORK_ADDRESS = 'foreman-work' as const
