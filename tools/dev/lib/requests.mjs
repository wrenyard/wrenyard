import { ERRORS } from './protocol.mjs';

/**
 * Serialize control requests. Concurrent restarts collapse to one pending restart.
 * stop wins over a restart that has not entered the switching phase.
 */
export function createRequestQueue() {
  let current = null;
  const restartWaiters = [];
  const stopWaiters = [];

  function settle(list, result) {
    const waiters = list.splice(0, list.length);
    for (const waiter of waiters) waiter(result);
  }

  return {
    get current() {
      return current;
    },
    get pendingRestart() {
      return restartWaiters.length > 0;
    },
    get pendingStop() {
      return stopWaiters.length > 0;
    },
    submit(kind) {
      if (kind !== 'restart' && kind !== 'stop') {
        throw new Error(`unsupported control kind: ${kind}`);
      }
      return new Promise((resolve, reject) => {
        const waiter = (result) => {
          if (result.ok) resolve(result);
          else reject(Object.assign(new Error(result.message), result));
        };
        if (kind === 'stop') stopWaiters.push(waiter);
        else restartWaiters.push(waiter);
      });
    },
    take() {
      if (current) return null;
      if (stopWaiters.length > 0) {
        if (restartWaiters.length > 0) {
          settle(restartWaiters, {
            ok: false,
            code: ERRORS.cancelled,
            message: 'restart cancelled because stop took priority',
          });
        }
        current = 'stop';
        return 'stop';
      }
      if (restartWaiters.length > 0) {
        current = 'restart';
        return 'restart';
      }
      return null;
    },
    finish(result) {
      const kind = current;
      current = null;
      if (kind === 'stop') settle(stopWaiters, result);
      else if (kind === 'restart') settle(restartWaiters, result);
    },
    cancelPending(message) {
      const result = { ok: false, code: ERRORS.cancelled, message };
      settle(restartWaiters, result);
      settle(stopWaiters, result);
    },
  };
}
