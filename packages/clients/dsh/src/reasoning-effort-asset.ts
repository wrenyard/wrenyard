/**
 * Loader row id and file name the generated overlay uses to mount the
 * reasoning-effort forwarder plugin for a Gateway route.
 */
export const DSH_REASONING_EFFORT_ROW_ID = 'wrenyard-dsh-reasoning-effort';
export const DSH_REASONING_EFFORT_PLUGIN_FILENAME = 'wrenyard-dsh-reasoning-effort.mjs';

/**
 * The internal header a Gateway route reads for the public reasoning effort.
 * It matches the header the OpenCode Gateway provider declares, so one Gateway
 * header contract serves every client.
 */
export const DSH_REASONING_EFFORT_HEADER = 'x-wrenyard-reasoning-effort';

/**
 * Environment names the generated plugin reads at runtime. The launch sets the
 * exact Gateway chat-completions URL and the PUBLIC effort level; the plugin
 * never performs provider-specific conversion, it only forwards the level.
 */
export const DSH_REASONING_EFFORT_ENV = 'WRENYARD_REASONING_EFFORT';
export const DSH_REASONING_EFFORT_URL_ENV = 'WRENYARD_REASONING_EFFORT_URL';

/**
 * The reasoning-effort forwarder plugin source, embedded with String.raw so the
 * literal is stored byte-for-byte and never interpreted as a template with
 * interpolation. It is a raw JavaScript asset written to disk for the native
 * DSH loader, not Wrenyard TypeScript.
 *
 * DSH's `llm-pi-ai` provider has no documented per-request header config, so the
 * plugin wraps the child's `globalThis.fetch` instead of touching the parent
 * adapter's fetch. For every request whose URL exactly matches the configured
 * Gateway chat-completions URL it adds the single effort header, preserving all
 * existing headers, body, options, and the Request-vs-URL input semantics;
 * every other request (and a launch with no configured URL/effort) passes
 * through untouched. The wrapper installs at most once per process.
 */
export const DSH_REASONING_EFFORT_PLUGIN_SOURCE = String.raw`export const name = 'wrenyard-dsh-reasoning-effort';
export const inject = [];

const HEADER = 'x-wrenyard-reasoning-effort';
const URL_ENV = 'WRENYARD_REASONING_EFFORT_URL';
const EFFORT_ENV = 'WRENYARD_REASONING_EFFORT';
const WRAPPER = Symbol.for('wrenyard.dsh.reasoning-effort.fetch-wrapped');

function sameEndpoint(target, candidate) {
  if (!candidate) return false;
  try {
    const left = new URL(target);
    const right = new URL(candidate);
    return left.href === right.href;
  } catch {
    return target === candidate;
  }
}

export function apply() {
  const target = process.env[URL_ENV];
  const effort = process.env[EFFORT_ENV];
  if (!target || !effort) return;
  const scope = globalThis;
  if (scope[WRAPPER] === true) return;
  const original = scope.fetch;
  if (typeof original !== 'function') return;
  const wrapped = function fetchWithReasoningEffort(input, init) {
    const isRequest = typeof input === 'object' && input !== null
      && typeof input.url === 'string' && typeof input.clone === 'function';
    if (isRequest) {
      if (!sameEndpoint(target, input.url)) return original.call(this, input, init);
      const headers = new Headers(init && init.headers !== undefined ? init.headers : input.headers);
      headers.set(HEADER, effort);
      const request = new Request(input, { ...(init || {}), headers });
      return original.call(this, request);
    }
    const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : '');
    if (!sameEndpoint(target, url)) return original.call(this, input, init);
    const headers = new Headers(init && init.headers ? init.headers : undefined);
    headers.set(HEADER, effort);
    return original.call(this, input, { ...(init || {}), headers });
  };
  Object.defineProperty(scope, 'fetch', {
    value: wrapped,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  Object.defineProperty(scope, WRAPPER, {
    value: true,
    writable: false,
    configurable: true,
    enumerable: false,
  });
}

export default { name, inject, apply };
`;
