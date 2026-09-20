import { createConnection, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const PRODUCT_NAME = '啾啾工坊';
export const SOURCE_DEV_FLAG = '1';

export interface ElectronPathApp {
  setName(name: string): void;
  setPath(name: 'userData' | string, path: string): void;
  getPath(name: 'appData' | 'userData' | string): string;
}

export function isSourceDevelopment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WRENYARD_SOURCE_DEV === SOURCE_DEV_FLAG;
}

export function isSupervised(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WRENYARD_DEV_SUPERVISED === SOURCE_DEV_FLAG;
}

export function resolveSourceDesktopUserData(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  appData?: string,
): string {
  const override = env.WRENYARD_DESKTOP_USER_DATA?.trim();
  if (override) return resolve(override);
  if (platform === 'win32') {
    return join(appData ?? env.APPDATA ?? join(home, 'AppData', 'Roaming'), PRODUCT_NAME);
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', PRODUCT_NAME);
  }
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return join(xdg ? resolve(xdg) : join(home, '.config'), PRODUCT_NAME);
}

/** Must run before app ready so the single-instance lock shares the installed identity. */
export function applySourceDevelopmentIdentity(
  app: ElectronPathApp,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!isSourceDevelopment(env)) return undefined;
  app.setName(PRODUCT_NAME);
  const userData = resolveSourceDesktopUserData(env, platform, homedir(), app.getPath('appData'));
  app.setPath('userData', userData);
  return userData;
}

export interface DesktopUiState {
  page?: string;
  selectedSessionId?: string;
  draft?: string;
  modalOpen?: boolean;
  streaming?: boolean;
}

export const CAPTURE_UI_SCRIPT = `(() => ({
  page: document.documentElement.dataset.page ?? 'workbench',
  draft: document.getElementById('conversation-input')?.value ?? '',
  modalOpen: Boolean(document.querySelector('[aria-modal="true"]:not([hidden])')),
}))()`;

export function restoreUiScript(state: DesktopUiState): string {
  const draft = JSON.stringify(state.draft ?? '');
  const page = JSON.stringify(state.page ?? '');
  return `(() => {
    const input = document.getElementById('conversation-input');
    if (input instanceof HTMLTextAreaElement) input.value = ${draft};
    if (${page}) document.documentElement.dataset.page = ${page};
    return true;
  })()`;
}

export interface SourceDevHost {
  activity(): Promise<{ running: boolean; streaming: boolean; modalOpen: boolean; busy: boolean }>;
  snapshotUi(): Promise<DesktopUiState>;
  restoreUi(state: DesktopUiState): Promise<void>;
  reload(): Promise<void>;
  quit(): Promise<void>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export function connectSourceSupervisor(
  endpoint: string,
  host: SourceDevHost,
): { close: () => void } {
  const socket: Socket = createConnection(endpoint);
  socket.setEncoding('utf8');
  let buffer = '';
  let nextId = 1;
  const pending = new Map<number, Pending>();

  const send = (message: unknown): void => {
    socket.write(`${JSON.stringify(message)}\n`);
  };

  socket.on('connect', () => {
    const id = nextId;
    nextId += 1;
    pending.set(id, { resolve: () => undefined, reject: () => undefined });
    send({ jsonrpc: '2.0', id, method: 'component.hello', params: { role: 'desktop', pid: process.pid } });
  });

  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message: {
        id?: number | string;
        method?: string;
        params?: DesktopUiState;
        result?: unknown;
        error?: { message?: string };
      };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        continue;
      }
      if (message.method && message.id != null) {
        void (async () => {
          try {
            const result = await dispatchHost(host, message.method!, message.params);
            send({ jsonrpc: '2.0', id: message.id, result: result ?? { ok: true } });
          } catch (error) {
            send({
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
            });
          }
        })();
        continue;
      }
      if (message.id != null && pending.has(Number(message.id))) {
        const waiter = pending.get(Number(message.id));
        pending.delete(Number(message.id));
        if (message.error) waiter?.reject(new Error(message.error.message ?? 'supervisor error'));
        else waiter?.resolve(message.result);
      }
    }
  });

  return {
    close() {
      socket.end();
    },
  };
}

async function dispatchHost(host: SourceDevHost, method: string, params?: DesktopUiState): Promise<unknown> {
  switch (method) {
    case 'desktop.activity':
      return host.activity();
    case 'desktop.snapshotUi':
      return host.snapshotUi();
    case 'desktop.restoreUi':
      await host.restoreUi(params ?? {});
      return { ok: true };
    case 'desktop.reload':
      await host.reload();
      return { ok: true };
    case 'desktop.quit':
      await host.quit();
      return { ok: true };
    default:
      throw new Error(`unknown supervisor method ${method}`);
  }
}
