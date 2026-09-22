/**
 * @wrenyard/session
 *
 * The conversation session feature: it owns the DSH backend child process, the
 * product conversation engine on top of it, the durable conversation document,
 * the summary-model preference and the bounded gateway/backend recovery
 * watcher. It exposes one versioned projection (`SessionSnapshotResult`) for
 * every action, and never exposes a secret, callback or Electron/DSH object to
 * its consumers.
 *
 * The service is constructed lazily and is safe to import before DSH exists.
 */
export { SessionService, createSessionService, type SessionServiceOptions } from './session-service.js';
