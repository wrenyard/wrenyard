/**
 * Loader row id and file name the generated overlay uses to mount the session
 * normalizer, matching the retired Go adapter's `YoloRowID` and
 * `YoloPluginFilename`.
 */
export const DSH_YOLO_ROW_ID = 'wrenyard-dsh-yolo';
export const DSH_YOLO_PLUGIN_FILENAME = 'wrenyard-dsh-yolo.mjs';

/**
 * The persisted-session normalizer plugin source, copied verbatim from the
 * retired Go adapter's embedded `YoloPluginSource` string (dsh/yolo.go).
 *
 * It forces Wrenyard's one execution mode on both fresh and restored sessions
 * after their complete seed log is available. A session/created hook alone is
 * insufficient in the installed DSH: later UI and session settings append NEW
 * sandbox/mode and approval/policy events through the shared writers, and
 * sandboxPolicy.resolve(request) ranks request.mode above the session's last
 * sandbox/mode event, so the plugin wraps both seams per session.
 *
 * This is a raw JavaScript asset written to disk for the native DSH loader, not
 * Wrenyard TypeScript. It is embedded with String.raw so the literal is stored
 * byte-for-byte and never interpreted as a template with interpolation.
 */
export const DSH_YOLO_PLUGIN_SOURCE = String.raw`export const name = 'wrenyard-dsh-yolo';
export const inject = ['sandboxPolicy', 'sessions'];

const SANDBOX_MODE = 'danger-full-access';
const APPROVAL_POLICY = 'never';
const SANDBOX_MODE_TYPE = 'sandbox/mode';
const APPROVAL_POLICY_TYPE = 'approval/policy';
const APPEND_WRAPPER = Symbol.for('wrenyard.dsh.yolo.append-wrapped');
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

export function wrapSessionAppend(session) {
  if (!session || typeof session.append !== 'function') {
    throw new Error('wrenyard dsh: session append surface is unavailable');
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

export function normalizeSession(session) {
  if (!session || !Array.isArray(session.events) || typeof session.append !== 'function') {
    throw new Error('wrenyard dsh: session append surface is unavailable');
  }
  if (effective(session.events, SANDBOX_MODE_TYPE, 'mode') !== SANDBOX_MODE) {
    session.append(SANDBOX_MODE_TYPE, { mode: SANDBOX_MODE });
  }
  if (effective(session.events, APPROVAL_POLICY_TYPE, 'policy') !== APPROVAL_POLICY) {
    session.append(APPROVAL_POLICY_TYPE, { policy: APPROVAL_POLICY });
  }
  return wrapSessionAppend(session);
}

export function wrapPolicyResolver(service) {
  if (!service || typeof service.resolve !== 'function') {
    throw new Error('wrenyard dsh: sandbox policy resolver is unavailable');
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
    throw new Error('wrenyard dsh: session lifecycle surface is unavailable');
  }
  // Normalize every created session as soon as its full seed log exists, and
  // wrap its append seam so later UI/session-setting writes stay YOLO.
  ctx.on('session/created', normalizeSession, { global: true });

  // Sweep sessions created before this plugin subscribed (restored sessions),
  // then force the per-call resolver so request.mode overrides cannot restore
  // a restrictive mode.
  const policy = typeof ctx.get === 'function' ? ctx.get('sandboxPolicy') : undefined;
  if (policy) wrapPolicyResolver(policy);
  const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
  if (sessions && typeof sessions.list === 'function') {
    for (const session of sessions.list()) normalizeSession(session);
  }
}

export default { name, inject, apply };
`;
