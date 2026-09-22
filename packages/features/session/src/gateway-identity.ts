/**
 * Electron-free gateway identity comparison used to decide whether a daemon
 * restart preserved the same gateway connection (same token, endpoints and
 * model identities) and therefore must not disturb a READY DSH session.
 *
 * Token values are compared in memory only; they are never logged, returned or
 * otherwise exposed. Both the real WrenyardGatewayConnection shape (top-level
 * openaiChatBaseUrl/openaiResponsesBaseUrl/anthropicBaseUrl and model objects)
 * and the structural test fixture (endpoints Record + string models) are
 * accepted so this module stays Electron-free.
 */

/** Shape-independent view of a gateway connection used for identity comparison. */
export interface GatewayConnectionIdentityInput {
  token: string;
  endpoints?: Record<string, string> | readonly (readonly [string, string])[];
  models?: readonly unknown[];
  openaiChatBaseUrl?: unknown;
  openaiResponsesBaseUrl?: unknown;
  anthropicBaseUrl?: unknown;
}

function stringify(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Endpoint identity strings for a connection, order-independent. */
function endpointIdentities(connection: GatewayConnectionIdentityInput): string[] {
  const identities: string[] = [];
  const endpoints = connection.endpoints;
  if (endpoints != null) {
    if (Array.isArray(endpoints)) {
      for (const entry of endpoints) {
        const identity = Array.isArray(entry) ? stringify(entry[1]) : undefined;
        if (identity !== undefined) identities.push(identity);
      }
    } else if (isRecord(endpoints)) {
      for (const value of Object.values(endpoints)) {
        const identity = stringify(value);
        if (identity !== undefined) identities.push(identity);
      }
    }
  }
  // Real Wrenyard connections carry each endpoint as a top-level base URL.
  for (const value of [
    connection.openaiChatBaseUrl,
    connection.openaiResponsesBaseUrl,
    connection.anthropicBaseUrl,
  ]) {
    const identity = stringify(value);
    if (identity !== undefined) identities.push(identity);
  }
  return identities;
}

/**
 * Model identity key for a connection, order-independent. Fixture models are
 * plain strings; real models are objects whose stable identity is provider plus
 * id/publicId. Display/pricing/speed metadata is never part of the identity.
 */
function modelIdentities(models: readonly unknown[]): string[] {
  const identities: string[] = [];
  for (const entry of models) {
    if (typeof entry === 'string' || typeof entry === 'number') {
      identities.push(String(entry));
      continue;
    }
    if (!isRecord(entry)) continue;
    const provider = stringify(entry.provider);
    const stableId = stringify(entry.id) ?? stringify(entry.publicId);
    if (provider === undefined && stableId === undefined) continue;
    identities.push(`${provider ?? ''}\u0000${stableId ?? ''}`);
  }
  return identities;
}

/** Multiset equality that is symmetric and order-independent. */
function identitySetsEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  if (left.length === 0) return true;
  const remaining = new Map<string, number>();
  for (const identity of left) {
    remaining.set(identity, (remaining.get(identity) ?? 0) + 1);
  }
  for (const identity of right) {
    const count = (remaining.get(identity) ?? 0) - 1;
    if (count < 0) return false;
    remaining.set(identity, count);
  }
  return true;
}

/**
 * True when both connections describe the same gateway: identical token,
 * identical endpoint identity set and identical model identity set, each
 * compared order-independently. The token is only compared against the other
 * input's token and is never logged or returned.
 */
export function sameGatewayIdentity(
  left: GatewayConnectionIdentityInput,
  right: GatewayConnectionIdentityInput,
): boolean {
  return left.token === right.token
    && identitySetsEqual(endpointIdentities(left), endpointIdentities(right))
    && identitySetsEqual(
      modelIdentities(left.models ?? []),
      modelIdentities(right.models ?? []),
    );
}
