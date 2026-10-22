/**
 * Compatibility re-export.
 *
 * The session model transport implementation moved to
 * `@wrenyard/model-call`; this entry keeps the original
 * `./transport/index.ts` import path working for existing session code and
 * the public `@wrenyard/session` surface.
 */
export * from '@wrenyard/model-call/transport';
