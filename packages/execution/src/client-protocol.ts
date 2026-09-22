import type { ForgeExecutor, ForgeExecutionOptions } from './forge.ts';
export interface RpcStep { method: string; params?: unknown; notification?: boolean; }
export interface RpcRequest { command: string; args: readonly string[]; env?: Readonly<Record<string, string | null>>; steps: readonly RpcStep[]; }
export class NativeOperationError extends Error {
  constructor(readonly code: string, readonly step?: number, readonly rpcCode?: number) { super('Native operation failed: ' + code); this.name = 'NativeOperationError'; }
}
/** Private wire protocol used only by client implementations. No provider semantics. */
export async function clientOperation(execution: ForgeExecutor, operation: 'rpc' | 'credential', request: unknown, options?: ForgeExecutionOptions): Promise<unknown> {
  const response = await execution.json(['client', operation], { ...options, input: JSON.stringify(request) });
  if (!response || typeof response !== 'object') throw new NativeOperationError('invalid_response');
  const result = response as { data?: unknown; error?: {code: string; step?: number; rpcCode?: number} };
  if (result.error) throw new NativeOperationError(result.error.code, result.error.step, result.error.rpcCode);
  return result.data;
}
export async function rpcSequence(execution: ForgeExecutor, request: RpcRequest, options?: ForgeExecutionOptions): Promise<unknown[]> {
  const data = await clientOperation(execution, 'rpc', request, options);
  if (!Array.isArray(data)) throw new NativeOperationError('invalid_response');
  return data;
}
