/**
 * Browser-safe model metadata entry.
 *
 * The narrow `@wrenyard/session/model-metadata` subpath: it exposes the pure
 * `resolveModelMetadata` helper together with the per-model protocol-selection
 * helpers, without importing the Node transport/HTTP graph or the sharp-backed
 * media module. A consumer such as Desktop's metadata-only bundle resolves a
 * model's protocols through it without dragging the session barrel in.
 */
/**
 * Compatibility re-export.
 *
 * The metadata implementation moved to `@wrenyard/model-call`; this entry
 * keeps the browser-safe `@wrenyard/session/model-metadata` subpath working for
 * existing consumers (for example Desktop's metadata-only bundle).
 */
export { SESSION_PROTOCOLS, selectSessionProtocol, supportsSession } from '@wrenyard/model-call/metadata';
export type { SessionProtocol } from '@wrenyard/model-call/metadata';
export { CONTEXT_OUTPUT_RESERVATION_CAP, boundedOutputReservation, resolveModelMetadata } from '@wrenyard/model-call/metadata';
export type { ModelMetadata } from '@wrenyard/model-call/metadata';
