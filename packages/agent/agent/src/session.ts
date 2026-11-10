import { startProcess, type ProcessSpec } from '@wrenyard/execution';
import { type AgentEvent, type AgentSession, type InternalAgentEvent, type OperationOptions, type StreamChunk } from './index.ts';
import { enrichFinishedEvent } from './native.ts';

type OpenedAgentSession = AgentSession & { readonly result: Promise<void> };

export async function openSession(
    spec: ProcessSpec,
    decode: (events: AsyncIterable<StreamChunk>) => AsyncIterable<AgentEvent | InternalAgentEvent>,
    options?: OperationOptions,
): Promise<OpenedAgentSession> {
    const execution = await startProcess(spec, options);
    let consumed = false;
    const events: AsyncIterable<AgentEvent> = {
        async *[Symbol.asyncIterator]() {
            if (consumed) return;
            consumed = true;
            let finished: Extract<AgentEvent, { type: 'finished' }> | undefined;
            let diagnostics = '';
            let decoderError: string | undefined;
            const source: AsyncIterable<StreamChunk> = {
                async *[Symbol.asyncIterator]() {
                    for await (const event of execution.events) {
                        if (event.type === 'stderr' && event.data)
                            diagnostics = (diagnostics + Buffer.from(event.data).toString('utf8')).slice(-16_384);
                        else if (event.type === 'error' && event.message)
                            diagnostics = (diagnostics + '\n' + event.message).slice(-16_384);
                        yield event;
                    }
                },
            };
            try {
                for await (const event of decode(source)) {
                    if (event.type === 'finished') {
                        finished ??= event;
                        continue;
                    }
                    if (event.type === 'error') {
                        decoderError = event.message;
                        continue;
                    }
                    if (event.type === 'stderr' || event.type === 'exit') continue;
                    if (finished) continue;
                    yield event;
                }
            }
            catch (error) {
                finished ??= { type: 'finished', status: 'failed', isError: true, error: error instanceof Error ? error.message : String(error) };
            }
            await execution.result.catch((error) => {
                decoderError ??= error instanceof Error ? error.message : String(error);
            });
            const final = finished ?? { type: 'finished', status: 'failed', isError: true, error: 'transport ended without a terminal result' };
            const withError = final.status === 'failed' && final.error === undefined && decoderError
                ? { ...final, error: decoderError }
                : final;
            yield enrichFinishedEvent(withError, diagnostics);
        },
    };
    return {
        events,
        // Internal adapters may use settlement for local cleanup; no transport
        // result data crosses the AgentSession contract.
        result: execution.result.then(() => undefined, () => undefined),
        cancel: () => execution.cancel(),
        diagnostics: execution.diagnostics,
    };
}
