import { ForgeExecutor, type ForgeExecutionOptions } from '@wrenyard/execution';
export type AccountUsageSource = 'cursor' | 'claude-coding' | 'super-grok';
/** Native client access only; direct HTTP and local observations belong to quota. */
export class AccountClient {
    constructor(private readonly execution: Pick<ForgeExecutor, 'json'> = new ForgeExecutor()) { }
    readClaudeOAuth(options?: ForgeExecutionOptions): Promise<unknown> { return this.execution.json(['client', 'claude-oauth', 'usage'], options); }
    readUsage(source: AccountUsageSource, options?: ForgeExecutionOptions): Promise<unknown> { return this.execution.json(['client', source, 'usage'], options); }
}
