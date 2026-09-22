/**
 * JSON-safe value model for the wire protocol.
 *
 * These aliases describe the subset of JavaScript values that survive a
 * `JSON.stringify`/`JSON.parse` round trip. They exist so DTO authors can
 * annotate open-ended payload slots (`JsonObject`) without falling back to
 * `any`.
 *
 * They are TYPES ONLY. They do not inspect, sanitize, or reject anything at
 * runtime; a value typed as `JsonValue` is a compile-time claim, not a
 * validated fact.
 */

export type JsonPrimitive = string | number | boolean | null

export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject

export interface JsonObject {
  [key: string]: JsonValue
}
