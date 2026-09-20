/** Source-development supervisor constants. Retry policy is also documented in CONTRIBUTING.md. */

export const PRODUCT_NAME = '啾啾工坊';
export const INSTANCE_VERSION = 1;
export const SOURCE_DEV_FLAG = '1';

/** Merge editor atomic saves and bursty multi-file edits. */
export const DEBOUNCE_MS = 300;

/** Explicit restart/stop/install-handover drain budget. */
export const DRAIN_TIMEOUT_MS = 60_000;

/** Unexpected component-exit retries. stop() aborts the sequence. */
export const COMPONENT_RETRY_LIMIT = 3;
export const COMPONENT_RETRY_BACKOFF_MS = [1_000, 2_000, 4_000];

export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_MAX_FILES = 3;

export const GRACEFUL_STOP_MS = 8_000;
/** Wait for an explicit --kill-desktop tree to actually exit. */
export const DESKTOP_KILL_WAIT_MS = 10_000;
export const HEALTH_WAIT_MS = 20_000;
export const CONTROL_CONNECT_MS = 2_000;
export const DESKTOP_READY_MS = 45_000;

export const WINDOWS_DEV_PIPE = '\\\\.\\pipe\\wrenyard-dev';
export const WINDOWS_BUSINESS_PIPE = '\\\\.\\pipe\\wrenyard';
export const POSIX_BUSINESS_SOCK = '/tmp/wrenyard.sock';

export const STATUSES = Object.freeze([
  'preparing',
  'waiting-for-idle',
  'starting',
  'ready',
  'pending',
  'restarting',
  'degraded',
  'stopping',
  'stopped',
]);

export const EXIT = Object.freeze({
  ok: 0,
  failed: 1,
});
