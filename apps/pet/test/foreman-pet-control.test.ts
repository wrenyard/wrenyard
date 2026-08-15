import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestForemanPetRestart } from '../src/main/foreman-pet-control';

describe('requestForemanPetRestart', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends pet.restart with params {} and returns true when an injected request is provided', async () => {
    const request = vi.fn().mockResolvedValue(undefined);
    const result = await requestForemanPetRestart({ request });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('pet.restart', {});
    expect(result).toBe(true);
  });

  it('returns false and warns about the bounded default-socket connection failure when no IPC path is configured', async () => {
    const warn = vi.fn();
    const logger = { warn };

    // Ensure environment has no IPC path set. The intentional /tmp/wrenyard.sock
    // default is used, and its (bounded) connection failure is reported as a
    // graceful warning rather than a missing-path configuration error.
    const restoreWrenyard = process.env['WRENYARD_IPC_PATH'];
    const restoreIpc = process.env['FOREMAN_PET_FOREMAN_IPC'];
    const restoreForeman = process.env['FOREMAN_IPC_PATH'];
    delete process.env['WRENYARD_IPC_PATH'];
    delete process.env['FOREMAN_PET_FOREMAN_IPC'];
    delete process.env['FOREMAN_IPC_PATH'];

    try {
      const result = await requestForemanPetRestart({ logger });

      expect(result).toBe(false);
      expect(warn).toHaveBeenCalledWith('Foreman pet restart request failed:', expect.any(Error));
      expect(warn).not.toHaveBeenCalledWith(
        'Foreman IPC path is not configured — cannot request pet restart',
      );
    } finally {
      // Restore env vars
      if (restoreWrenyard !== undefined) process.env['WRENYARD_IPC_PATH'] = restoreWrenyard;
      else delete process.env['WRENYARD_IPC_PATH'];
      if (restoreIpc !== undefined) process.env['FOREMAN_PET_FOREMAN_IPC'] = restoreIpc;
      else delete process.env['FOREMAN_PET_FOREMAN_IPC'];
      if (restoreForeman !== undefined) process.env['FOREMAN_IPC_PATH'] = restoreForeman;
      else delete process.env['FOREMAN_IPC_PATH'];
    }
  });

  it('returns false when the injected request rejects and still calls injected close', async () => {
    const request = vi.fn().mockRejectedValue(new Error('connection refused'));
    const close = vi.fn();
    const warn = vi.fn();
    const logger = { warn };

    const result = await requestForemanPetRestart({ request, close, logger });

    expect(result).toBe(false);
    expect(request).toHaveBeenCalledWith('pet.restart', {});
    expect(warn).toHaveBeenCalledWith('Foreman pet restart request failed:', expect.any(Error));
    expect(close).toHaveBeenCalledWith(expect.any(Error));
  });
});
