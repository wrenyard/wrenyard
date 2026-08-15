import { ForemanIpcClient, resolveForemanIpcPath } from './foreman-ipc-client';

interface MinimalLogger {
  warn(message: string, ...args: unknown[]): void;
}

interface RequestForemanPetRestartOptions {
  request?: (method: string, params?: unknown) => Promise<unknown>;
  ipcPath?: string;
  close?: (error?: Error) => void;
  logger?: MinimalLogger;
}

export async function requestForemanPetRestart(options: RequestForemanPetRestartOptions = {}): Promise<boolean> {
  const logger = options.logger ?? console;

  if (options.request) {
    let closeReason = new Error('Foreman pet restart request complete');
    try {
      await options.request('pet.restart', {});
      return true;
    } catch (err) {
      closeReason = err instanceof Error ? err : new Error(String(err));
      logger.warn('Foreman pet restart request failed:', err);
      return false;
    } finally {
      options.close?.(closeReason);
    }
  }

  const ipcPath = options.ipcPath ?? resolveForemanIpcPath();
  if (!ipcPath) {
    logger.warn('Foreman IPC path is not configured — cannot request pet restart');
    return false;
  }

  const client = new ForemanIpcClient({ path: ipcPath });
  let closeReason = new Error('Foreman pet restart request complete');
  try {
    await client.request('pet.restart', {});
    return true;
  } catch (err) {
    closeReason = err instanceof Error ? err : new Error(String(err));
    logger.warn('Foreman pet restart request failed:', err);
    return false;
  } finally {
    client.close(closeReason);
  }
}
