import { describe, expect, it, vi } from 'vitest';

import {
  runAgentLoop,
  type AgentLoopModelStepOutcome,
  type AgentLoopStepOutcome,
  type AgentLoopStepStatus,
  type RunAgentLoopOptions,
} from '../src/index.ts';

function createHarness(overrides: Partial<RunAgentLoopOptions> = {}) {
  const calls: string[] = [];
  const finishStatuses: Array<{ step: number; status: AgentLoopStepStatus }> = [];
  let finished = false;
  let aborted = false;

  const options: RunAgentLoopOptions = {
    isFinished: () => finished,
    isAborted: () => aborted,
    prepareStep: async (step) => {
      calls.push(`prepare:${step}`);
    },
    runModelStep: async (step) => {
      calls.push(`model:${step}`);
      return { ok: true, terminal: true };
    },
    executeStepActions: async (step) => {
      calls.push(`actions:${step}`);
      return { continueLoop: false };
    },
    finishStep: async (step, status) => {
      calls.push(`finish:${step}:${status}`);
      finishStatuses.push({ step, status });
    },
    onTurnFailed: async (error, failure) => {
      calls.push(`failed:${error ?? ''}:${String(failure ?? '')}`);
    },
    onTurnException: async (error) => {
      calls.push(`exception:${error instanceof Error ? error.message : String(error)}`);
    },
    ...overrides,
  };

  return {
    options,
    calls,
    finishStatuses,
    setFinished: (value: boolean) => { finished = value; },
    setAborted: (value: boolean) => { aborted = value; },
  };
}

describe('runAgentLoop', () => {
  it('completes a normal single-step terminal turn', async () => {
    const executeStepActions = vi.fn(async (): Promise<AgentLoopStepOutcome> => ({ continueLoop: true }));
    const onTurnFailed = vi.fn(async () => {});
    const onTurnException = vi.fn(async () => {});
    const harness = createHarness({
      executeStepActions,
      onTurnFailed,
      onTurnException,
    });

    await runAgentLoop(harness.options);

    expect(harness.calls).toEqual(['prepare:1', 'model:1', 'finish:1:done']);
    expect(harness.finishStatuses).toEqual([{ step: 1, status: 'done' }]);
    expect(executeStepActions).not.toHaveBeenCalled();
    expect(onTurnFailed).not.toHaveBeenCalled();
    expect(onTurnException).not.toHaveBeenCalled();
  });

  it('continues across multiple steps until a terminal model step', async () => {
    const calls: string[] = [];
    const finishStatuses: Array<{ step: number; status: AgentLoopStepStatus }> = [];
    const runModelStep = vi.fn(async (step: number): Promise<AgentLoopModelStepOutcome> => {
      calls.push(`model:${step}`);
      if (step < 3) return { ok: true, terminal: false };
      return { ok: true, terminal: true };
    });
    const executeStepActions = vi.fn(async (step: number): Promise<AgentLoopStepOutcome> => {
      calls.push(`actions:${step}`);
      return { continueLoop: true };
    });
    const harness = createHarness({
      prepareStep: async (step) => {
        calls.push(`prepare:${step}`);
      },
      runModelStep,
      executeStepActions,
      finishStep: async (step, status) => {
        calls.push(`finish:${step}:${status}`);
        finishStatuses.push({ step, status });
      },
    });

    await runAgentLoop(harness.options);

    expect(runModelStep).toHaveBeenCalledTimes(3);
    expect(executeStepActions).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([
      'prepare:1', 'model:1', 'actions:1', 'finish:1:done',
      'prepare:2', 'model:2', 'actions:2', 'finish:2:done',
      'prepare:3', 'model:3', 'finish:3:done',
    ]);
    expect(finishStatuses).toEqual([
      { step: 1, status: 'done' },
      { step: 2, status: 'done' },
      { step: 3, status: 'done' },
    ]);
  });

  it('triggers onTurnFailed and finishes the step with failed status on model failure', async () => {
    const calls: string[] = [];
    const finishStatuses: Array<{ step: number; status: AgentLoopStepStatus }> = [];
    const failure = { kind: 'rate_limited', status: 429 };
    let finished = false;
    const onTurnFailed = vi.fn(async (err: string | undefined, fail: unknown) => {
      calls.push(`failed:${err ?? ''}`);
      finished = true;
      expect(err).toBe('rate limit exceeded');
      expect(fail).toBe(failure);
    });
    const onTurnException = vi.fn(async () => {});
    const executeStepActions = vi.fn(async (): Promise<AgentLoopStepOutcome> => ({ continueLoop: true }));
    const harness = createHarness({
      isFinished: () => finished,
      prepareStep: async (step) => {
        calls.push(`prepare:${step}`);
      },
      runModelStep: async (step) => {
        calls.push(`model:${step}`);
        return { ok: false, error: 'rate limit exceeded', failure };
      },
      finishStep: async (step, status) => {
        calls.push(`finish:${step}:${status}`);
        finishStatuses.push({ step, status });
      },
      onTurnFailed,
      onTurnException,
      executeStepActions,
    });

    await runAgentLoop(harness.options);

    expect(onTurnFailed).toHaveBeenCalledTimes(1);
    expect(onTurnException).not.toHaveBeenCalled();
    expect(executeStepActions).not.toHaveBeenCalled();
    expect(finishStatuses).toEqual([{ step: 1, status: 'failed' }]);
    expect(calls).toEqual(['prepare:1', 'model:1', 'failed:rate limit exceeded', 'finish:1:failed']);
  });

  it('recovers from an unexpected exception by finishing the step and invoking onTurnException', async () => {
    const calls: string[] = [];
    const finishStatuses: Array<{ step: number; status: AgentLoopStepStatus }> = [];
    const boom = new Error('unexpected crash');
    const onTurnException = vi.fn(async (error: unknown) => {
      calls.push(`exception:${error instanceof Error ? error.message : String(error)}`);
    });
    const harness = createHarness({
      prepareStep: async (step) => {
        calls.push(`prepare:${step}`);
      },
      runModelStep: async (step) => {
        calls.push(`model:${step}`);
        return { ok: true, terminal: false };
      },
      executeStepActions: async () => {
        throw boom;
      },
      finishStep: async (step, status) => {
        calls.push(`finish:${step}:${status}`);
        finishStatuses.push({ step, status });
      },
      onTurnException,
    });

    await runAgentLoop(harness.options);

    expect(onTurnException).toHaveBeenCalledTimes(1);
    expect(onTurnException).toHaveBeenCalledWith(boom);
    expect(finishStatuses).toEqual([{ step: 1, status: 'failed' }]);
    expect(calls).toEqual(['prepare:1', 'model:1', 'finish:1:failed', 'exception:unexpected crash']);
  });
});
