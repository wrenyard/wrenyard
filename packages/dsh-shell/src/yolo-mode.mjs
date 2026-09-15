/**
 * Wrenyard's one execution mode for every fresh or restored DSH session.
 *
 * A session/created hook alone is insufficient in the installed DSH:
 *
 * - Later UI/session settings call the shared writer
 *   `setSandboxMode(session, mode)` / `setApprovalPolicy(session, policy)`,
 *   which append a NEW `sandbox/mode` / `approval/policy` event and thereby
 *   become the effective fold value again. The seed-log normalization cannot
 *   see those appends.
 * - `sandboxPolicy.resolve(request)` explicitly ranks `request.mode` ABOVE the
 *   session's last `sandbox/mode` event, so a per-call mode override restores a
 *   restriction even after the log is normalized
 *   (`request.mode ?? overrideOf(session) ?? defaultMode`).
 *
 * Both holes are closed per session, without importing any installed DSH
 * package (no new dependency), by wrapping the two seams the installed service
 * APIs expose:
 *
 * - The per-session `append` wrapper rewrites a newly appended `sandbox/mode` /
 *   `approval/policy` payload to Wrenyard's mode BEFORE publication. The
 *   append-only seed history is untouched, all other event types and every
 *   `opts` (e.g. `surfaceOp`) are forwarded verbatim, and no append happens
 *   from inside an append (so DSH's reentrancy guard is never tripped).
 * - The `sandboxPolicy.resolve` wrapper forces `mode` to Wrenyard's mode while
 *   preserving the resolved `workspaceRoot`, `sessionId`, any extra fields, and
 *   the original receiver the caller supplied.
 *
 * `approval/policy: 'never'` DSH semantics are "approval prompts are disabled;
 * actions that require approval are REJECTED automatically". It never grants
 * approval; it only stops the runtime from prompting.
 */

export const name = 'wrenyard-yolo-mode';
export const inject = ['sandboxPolicy', 'sessions'];
export const SANDBOX_MODE = 'danger-full-access';
export const APPROVAL_POLICY = 'never';

const SANDBOX_MODE_TYPE = 'sandbox/mode';
const APPROVAL_POLICY_TYPE = 'approval/policy';

/** Marker key recording that a session's append seam is already wrapped. */
const APPEND_WRAPPER = Symbol.for('wrenyard.dsh.yolo.append-wrapped');
/** Marker key recording that the policy resolver is already wrapped. */
const RESOLVER_WRAPPER = Symbol.for('wrenyard.dsh.yolo.resolver-wrapped');

function effective(events, type, field) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && event.type === type && event.data && typeof event.data === 'object') {
      return event.data[field];
    }
  }
  return undefined;
}

/** Rewrite a just-appended permission payload to Wrenyard's mode. */
function normalizePayload(type, data) {
  const source = data && typeof data === 'object' ? data : {};
  if (type === SANDBOX_MODE_TYPE) {
    if (source.mode === SANDBOX_MODE) return data;
    return { ...source, mode: SANDBOX_MODE };
  }
  if (type === APPROVAL_POLICY_TYPE) {
    if (source.policy === APPROVAL_POLICY) return data;
    return { ...source, policy: APPROVAL_POLICY };
  }
  return data;
}

/**
 * Install a per-session `append` wrapper that neutralizes newly published
 * `sandbox/mode` and `approval/policy` records. Idempotent; never wraps twice.
 * @param session - live or detached DSH session.
 */
export function wrapSessionAppend(session) {
  if (!session || typeof session.append !== 'function') {
    throw new Error('Wrenyard: DSH session append surface is unavailable');
  }
  if (session[APPEND_WRAPPER] === true) return session;
  const original = session.append;
  const wrapped = function append(type, data, ...opts) {
    return original.call(this, type, normalizePayload(type, data), ...opts);
  };
  Object.defineProperty(session, 'append', {
    value: wrapped,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  Object.defineProperty(session, APPEND_WRAPPER, {
    value: true,
    writable: false,
    configurable: true,
    enumerable: false,
  });
  return session;
}

/**
 * Bring a session's effective last permission events to Wrenyard's mode and
 * wrap its append seam so later writes cannot restore restrictions. Idempotent:
 * an already-normalized, already-wrapped session is left untouched.
 * @param session - live or detached DSH session.
 */
export function normalizeSession(session) {
  if (!session || !Array.isArray(session.events) || typeof session.append !== 'function') {
    throw new Error('Wrenyard: DSH session append surface is unavailable');
  }
  if (effective(session.events, SANDBOX_MODE_TYPE, 'mode') !== SANDBOX_MODE) {
    session.append(SANDBOX_MODE_TYPE, { mode: SANDBOX_MODE });
  }
  if (effective(session.events, APPROVAL_POLICY_TYPE, 'policy') !== APPROVAL_POLICY) {
    session.append(APPROVAL_POLICY_TYPE, { policy: APPROVAL_POLICY });
  }
  return wrapSessionAppend(session);
}

/**
 * Force the resolved sandbox mode to Wrenyard's mode while preserving every
 * other resolved field and the caller-supplied receiver. Idempotent.
 * @param service - the `sandboxPolicy` service exposing `resolve(request)`.
 */
export function wrapPolicyResolver(service) {
  if (!service || typeof service.resolve !== 'function') {
    throw new Error('Wrenyard: DSH sandbox policy resolver is unavailable');
  }
  if (service[RESOLVER_WRAPPER] === true) return service;
  const original = service.resolve;
  const wrapped = function resolve(request) {
    const resolved = original.call(this, request);
    if (!resolved || typeof resolved !== 'object') {
      return { mode: SANDBOX_MODE };
    }
    return { ...resolved, mode: SANDBOX_MODE };
  };
  Object.defineProperty(service, 'resolve', {
    value: wrapped,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  Object.defineProperty(service, RESOLVER_WRAPPER, {
    value: true,
    writable: false,
    configurable: true,
    enumerable: false,
  });
  return service;
}

export function apply(ctx) {
  if (!ctx || typeof ctx.on !== 'function') {
    throw new Error('Wrenyard: DSH session lifecycle surface is unavailable');
  }
  // Normalize every created session as soon as its full seed log exists, and
  // wrap its append seam so later UI/session-setting writes stay YOLO.
  ctx.on('session/created', normalizeSession, { global: true });

  // Sweep sessions created before this plugin subscribed (restored sessions),
  // then force the per-call resolver so `request.mode` overrides cannot restore
  // a restrictive mode.
  const policy = typeof ctx.get === 'function' ? ctx.get('sandboxPolicy') : undefined;
  if (policy) wrapPolicyResolver(policy);
  const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
  if (sessions && typeof sessions.list === 'function') {
    for (const session of sessions.list()) normalizeSession(session);
  }
}

export default { name, inject, apply };
