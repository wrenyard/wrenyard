import { startProcess, type ProcessSpec } from '@wrenyard/execution';
import { type AgentEvent, type AgentSession, type OperationOptions, type StreamChunk } from './index.ts';

export async function openSession(
    spec: ProcessSpec,
    decode: (events: AsyncIterable<StreamChunk>) => AsyncIterable<AgentEvent>,
    options?: OperationOptions,
): Promise<AgentSession> {
    const execution = await startProcess(spec, options);
    // The decoder wraps the execution event stream exactly once and stays lazy:
    // events are consumed only as the caller iterates. Decoding only here keeps
    // the execution queue owned by the single returned iterable.
    return {
        events: decode(execution.events),
        result: execution.result.then((result) => ({ exitCode: result.exitCode })),
        cancel: () => execution.cancel(),
        diagnostics: execution.diagnostics,
    };
}
