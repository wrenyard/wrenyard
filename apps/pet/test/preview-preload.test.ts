import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const preload = require('../scripts/preview-capture-preload.cjs');

describe('preview capture preload contract', () => {
  it('reads exactly one serialized fixture argument', async () => {
    const { WORKER_FIXTURES, serializeFixture } = await import('../scripts/preview/fixtures.mjs');
    const arg = `${preload.FIXTURE_ARG_PREFIX}${encodeURIComponent(serializeFixture(WORKER_FIXTURES[0]))}`;
    expect(preload.readFixtureFromArgv(['electron', arg])).toMatchObject({
      kind: 'worker',
      file: 'worker-skin-classic-codebuddy.png',
    });
    expect(() => preload.readFixtureFromArgv(['electron'])).toThrow(/expected exactly one/);
    expect(() => preload.readFixtureFromArgv([arg, arg])).toThrow(/expected exactly one/);
  });

  it('exposes the exact PetApi method names and no preview-only methods', async () => {
    const { WORKER_FIXTURES } = await import('../scripts/preview/fixtures.mjs');
    const api = preload.createPreviewPetApi(WORKER_FIXTURES[0]);
    expect(Object.keys(api)).toEqual([
      'onSnapshot',
      'onHouseUpdate',
      'onWorkerUpdate',
      'getConfig',
      'setHouseMousePassthrough',
      'houseDragStart',
      'houseDragMove',
      'houseDragEnd',
      'dismissBroadcast',
      'setWorkerMousePassthrough',
      'workerDragStart',
      'workerDragMove',
      'workerDragEnd',
    ]);
    expect(Object.keys(api).some((name) => name.toLowerCase().includes('preview'))).toBe(false);
  });

  it('synchronously publishes complete worker and house renderer state for matching subscriptions', async () => {
    const { WORKER_FIXTURES, HOUSE_FIXTURES } = await import('../scripts/preview/fixtures.mjs');
    const workerApi = preload.createPreviewPetApi(WORKER_FIXTURES[0]);
    const workerCb = vi.fn();
    const workerUnsubscribe = workerApi.onWorkerUpdate(workerCb);
    expect(workerUnsubscribe).toBeTypeOf('function');
    expect(workerCb).toHaveBeenCalledTimes(1);
    expect(workerCb.mock.calls[0][0]).toMatchObject({
      scale: 5,
      worker: { workerIdentityKey: 'visual-worker' },
      infoCard: {
        workerIdentityKey: 'visual-worker',
        profile: 'preview',
        status: 'working',
        toolCount: 0,
        isWorktree: false,
      },
    });
    expect(Object.keys(workerCb.mock.calls[0][0].infoCard)).toEqual([
      'workerIdentityKey',
      'profile',
      'status',
      'toolCount',
      'durationMs',
      'isWorktree',
    ]);

    const houseApi = preload.createPreviewPetApi(HOUSE_FIXTURES[2]);
    const houseCb = vi.fn();
    const houseUnsubscribe = houseApi.onHouseUpdate(houseCb);
    expect(houseUnsubscribe).toBeTypeOf('function');
    expect(houseCb).toHaveBeenCalledWith(HOUSE_FIXTURES[2].value);
  });
});
