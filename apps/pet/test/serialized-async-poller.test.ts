import { describe, expect, it } from 'vitest';
import { SerializedAsyncPoller, type AsyncPollTimerApi } from '../src/main/serialized-async-poller';

class ManualTimers implements AsyncPollTimerApi {
  private nextId = 0;
  private readonly callbacks = new Map<number, () => void>();

  setTimeout(callback: () => void): number {
    const id = ++this.nextId;
    this.callbacks.set(id, callback);
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.callbacks.delete(handle as number);
  }

  runNext(): void {
    const next = this.callbacks.entries().next().value as [number, () => void] | undefined;
    if (!next) return;
    this.callbacks.delete(next[0]);
    next[1]();
  }

  get pending(): number {
    return this.callbacks.size;
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('SerializedAsyncPoller', () => {
  it('can begin immediately while retaining serialized follow-up scheduling', async () => {
    const timers = new ManualTimers();
    const poller = new SerializedAsyncPoller(2_000, timers);
    let calls = 0;

    poller.start('list', async () => {
      calls++;
      return true;
    }, undefined, true);
    await flushPromises();

    expect(calls).toBe(1);
    expect(poller.isActive('list')).toBe(true);
    expect(timers.pending).toBe(1);
  });

  it('never schedules a second request while the current request is pending', async () => {
    const timers = new ManualTimers();
    const poller = new SerializedAsyncPoller(2_000, timers);
    const first = deferred<boolean>();
    let calls = 0;

    poller.start('run-1', async () => {
      calls++;
      return first.promise;
    });
    timers.runNext();

    expect(calls).toBe(1);
    expect(timers.pending).toBe(0);
    timers.runNext();
    expect(calls).toBe(1);

    first.resolve(true);
    await flushPromises();
    expect(timers.pending).toBe(1);
  });

  it('invalidates an in-flight callback when the key is replaced', async () => {
    const timers = new ManualTimers();
    const poller = new SerializedAsyncPoller(2_000, timers);
    const oldRequest = deferred<void>();
    const published: string[] = [];

    poller.start('run-1', async (isCurrent) => {
      await oldRequest.promise;
      if (isCurrent()) published.push('old');
      return true;
    });
    timers.runNext();

    poller.start('run-1', async (isCurrent) => {
      if (isCurrent()) published.push('new');
      return false;
    });
    timers.runNext();
    await flushPromises();

    oldRequest.resolve();
    await flushPromises();

    expect(published).toEqual(['new']);
    expect(timers.pending).toBe(0);
  });

  it('invalidates an in-flight callback when stopped', async () => {
    const timers = new ManualTimers();
    const poller = new SerializedAsyncPoller(2_000, timers);
    const request = deferred<void>();
    let published = false;

    poller.start('run-1', async (isCurrent) => {
      await request.promise;
      published = isCurrent();
      return true;
    });
    timers.runNext();
    poller.stop('run-1');
    request.resolve();
    await flushPromises();

    expect(published).toBe(false);
    expect(timers.pending).toBe(0);
  });
});
