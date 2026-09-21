import { createServer, createConnection } from 'node:net';
import { unlinkSync } from 'node:fs';

const CONTROL_CONNECT_MS = 2_000;

export function encodeMessage(message) {
  return `${JSON.stringify(message)}\n`;
}

export function createFrameParser(onMessage) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch (error) {
          onMessage({ type: 'parse-error', error: error instanceof Error ? error.message : String(error), raw: line });
          continue;
        }
        onMessage(parsed);
      }
    },
    rest() {
      return buffer;
    },
  };
}

function resultMessage(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function errorMessage(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

export const ERRORS = Object.freeze({
  parse: -32700,
  invalid: -32600,
  method: -32601,
  params: -32602,
  internal: -32603,
  busy: 1,
  wrongCheckout: 2,
  notRunning: 3,
  degraded: 4,
  cancelled: 5,
  desktopRunning: 6,
});

export function isAddrInUse(error) {
  return Boolean(error && (error.code === 'EADDRINUSE' || error.code === 'EEXIST'));
}

export function listenControl(endpoint, options = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    const onError = (error) => {
      server.off('error', onError);
      reject(error);
    };
    server.once('error', onError);
    server.listen(endpoint, () => {
      server.off('error', onError);
      resolve(server);
    });
  }).catch(async (error) => {
    if (options.platform !== 'win32' && isAddrInUse(error) && options.retryStale) {
      try {
        unlinkSync(endpoint);
      } catch {
        // Ignore missing stale sockets.
      }
      return listenControl(endpoint, { ...options, retryStale: false });
    }
    throw error;
  });
}

export function attachHandler(server, handlers, onConnection) {
  server.on('connection', (socket) => {
    socket.setEncoding('utf8');
    const pending = new Map();
    const session = {
      send(message) {
        socket.write(encodeMessage(message));
      },
      request(method, params) {
        const id = `s${pending.size + 1}-${Date.now()}`;
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          socket.write(encodeMessage({ jsonrpc: '2.0', id, method, params: params ?? {} }));
        });
      },
      socket,
    };
    onConnection?.(session);
    const parser = createFrameParser(async (message) => {
      if (message?.type === 'parse-error') {
        session.send(errorMessage(null, ERRORS.parse, 'invalid json'));
        return;
      }
      if (message?.id != null && Object.hasOwn(message, 'result')) {
        const waiter = pending.get(message.id);
        if (waiter) {
          pending.delete(message.id);
          waiter.resolve(message.result);
        }
        return;
      }
      if (message?.id != null && message.error) {
        const waiter = pending.get(message.id);
        if (waiter) {
          pending.delete(message.id);
          waiter.reject(Object.assign(new Error(message.error.message), { code: message.error.code, data: message.error.data }));
        }
        return;
      }
      const id = message?.id;
      const method = message?.method;
      const handler = typeof method === 'string' ? handlers[method] : undefined;
      if (!handler) {
        session.send(errorMessage(id ?? null, ERRORS.method, `Unknown method: ${method ?? ''}`));
        return;
      }
      try {
        const result = await handler(message.params ?? {}, session);
        if (id != null) session.send(resultMessage(id, result ?? { ok: true }));
      } catch (error) {
        const code = Number.isInteger(error?.code) ? error.code : ERRORS.internal;
        session.send(errorMessage(id ?? null, code, error instanceof Error ? error.message : String(error), error?.data));
      }
    });
    socket.on('data', (chunk) => parser.push(chunk));
    socket.on('close', () => {
      for (const waiter of pending.values()) waiter.reject(new Error('control connection closed'));
      pending.clear();
    });
  });
  return server;
}

export function connectControl(endpoint, timeoutMs = CONTROL_CONNECT_MS) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    socket.setEncoding('utf8');
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`control endpoint did not accept a connection within ${timeoutMs}ms`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      let nextId = 1;
      const pending = new Map();
      const parser = createFrameParser((message) => {
        if (message?.id == null) return;
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (message.error) {
          waiter.reject(Object.assign(new Error(message.error.message), { code: message.error.code, data: message.error.data }));
        } else {
          waiter.resolve(message.result);
        }
      });
      socket.on('data', (chunk) => parser.push(chunk));
      socket.on('close', () => {
        for (const waiter of pending.values()) waiter.reject(new Error('control connection closed'));
        pending.clear();
      });
      resolve({
        socket,
        request(method, params, requestTimeoutMs = 120_000) {
          const id = nextId;
          nextId += 1;
          return new Promise((resolveRequest, rejectRequest) => {
            const requestTimer = setTimeout(() => {
              pending.delete(id);
              rejectRequest(new Error(`control request timed out (${method})`));
            }, requestTimeoutMs);
            pending.set(id, {
              resolve: (result) => {
                clearTimeout(requestTimer);
                resolveRequest(result);
              },
              reject: (error) => {
                clearTimeout(requestTimer);
                rejectRequest(error);
              },
            });
            socket.write(encodeMessage({ jsonrpc: '2.0', id, method, params: params ?? {} }));
          });
        },
        close() {
          socket.end();
        },
      });
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
