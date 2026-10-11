import type { GatewayProtocolModule } from './protocols/types.ts';
import { object } from './protocols/types.ts';

/**
 * The upstream's original error facts, captured before any mapping. These are
 * recorded on the `gateway.request.completed` event so the supplier's actual
 * behavior can be audited later, independent of the entry-protocol body a
 * client received.
 */
export interface UpstreamErrorFact {
  status: number;
  type?: string;
  code?: string;
  retryAfter?: string;
  retryAfterMs?: string;
}

const identityOf = (body: unknown): { type?: string; code?: string } => {
  const root = object(body);
  if (!root) return {};
  const error = object(root.error) ?? root;
  return {
    ...(typeof error.type === 'string' ? { type: error.type } : {}),
    ...(typeof error.code === 'string' ? { code: error.code } : {}),
  };
};

/** The upstream's own retry hints, exactly as received, when present. */
function retryHints(headers: Headers): { retryAfter?: string; retryAfterMs?: string } {
  const retryAfter = headers.get('retry-after') ?? undefined;
  const retryAfterMs = headers.get('retry-after-ms') ?? undefined;
  return {
    ...(retryAfter === undefined ? {} : { retryAfter }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

/** The upstream's own `{type, code}` and retry hints, exactly as received. */
export function upstreamErrorFact(status: number, headers: Headers, body: unknown): UpstreamErrorFact {
  const identity = identityOf(body);
  return { status, ...identity, ...retryHints(headers) };
}

/**
 * The upstream's original facts for an official stream error observed after an
 * HTTP success status: the `{type, code}` a protocol module extracted from the
 * error frame plus the upstream's own retry hints. The status stays the real
 * upstream status (HTTP 200), because that is what the supplier returned.
 */
export function streamErrorFact(
  status: number,
  headers: Headers,
  identity: { type?: string; code?: string },
): UpstreamErrorFact {
  return { status, ...identity, ...retryHints(headers) };
}

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

/** A readable supplier message: the error's own wording, else the raw excerpt. */
function supplierMessage(body: unknown, bytes: Uint8Array): string {
  const root = object(body);
  const error = object(root?.error);
  for (const candidate of [error?.message, root?.message, typeof root?.error === 'string' ? root.error : undefined]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
  }
  const text = new TextDecoder().decode(bytes).trim();
  return text === '' ? 'Upstream request failed' : text.slice(0, 2000);
}

/**
 * The error body to send downstream for an upstream failure.
 *
 * The default is verbatim pass-through: an official entry-protocol error body
 * keeps the upstream status and its exact bytes, so `param`, `code` and every
 * other official detail survive unchanged. Only a body that is not that
 * protocol's official error shape is wrapped in the official envelope, keeping
 * the upstream status and the supplier's own wording. The envelope itself is
 * owned by the protocol module: Chat/Responses produce the complete
 * `{error:{message,type,code,param}}` shape with `code`/`param` null, Messages
 * its official `{type:"error",error:{type,message}}` shape.
 */
export function mapUpstreamErrorBody(
  module: GatewayProtocolModule,
  status: number,
  bytes: Uint8Array,
  body: unknown,
): { status: number; bytes: Uint8Array } {
  if (module.isOfficialErrorBody(body)) return { status, bytes };
  return {
    status,
    bytes: encode(module.errorEnvelope(module.errorTypeForStatus(status), supplierMessage(body, bytes))),
  };
}

/**
 * A Gateway-originated error. The Gateway defines no vocabulary of its own: the
 * body is the entry protocol's official envelope, whose `type` the protocol
 * module derives from the status, and retryability is expressed by the status
 * code alone.
 */
export function gatewayErrorBody(
  module: GatewayProtocolModule,
  status: number,
  message: string,
): Record<string, unknown> {
  return module.errorEnvelope(module.errorTypeForStatus(status), message);
}
