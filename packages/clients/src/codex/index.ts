import { ForgeExecutor, type ForgeExecutionOptions } from '@wrenyard/execution';

/** Client protocol access only; no quota policy or provider imports. */
export class CodexClient {
  constructor(private readonly execution: Pick<ForgeExecutor, 'json'> = new ForgeExecutor()) {}

  readRateLimits(options?: ForgeExecutionOptions): Promise<unknown> {
    return this.execution.json(['client', 'codex', 'rate-limits'], options);
  }
}
