/**
 * Session feature wire DTOs: the read-only context inspection and auxiliary
 * route preview contracts.
 *
 * Declared independently of any runtime package, exactly like the provider and
 * exec surfaces: the shapes are structural and describe what crosses the IPC
 * boundary, with no import from `@wrenyard/session` (or any other runtime
 * package). The daemon holds the runtime JSON schema that validates these.
 */
export * from './context.ts'
export * from './attachments.ts'
export * from './types.ts'
export * from './methods.ts'
