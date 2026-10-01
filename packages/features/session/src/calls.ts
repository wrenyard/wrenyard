/**
 * session model calls.
 *
 * One call is one stateless request: pick the role's model, resolve its model
 * metadata, estimate the input with `cl100k_base`, enforce the context budget,
 * run it through a `ModelDriver` under the role's timeout, and write exactly
 * one `call` ledger event for the attempt. The runner keeps no session state,
 * never parses JSON output and never repairs schemas — those belong to
 * `actions.ts` / `engine.ts`.
 */
import { getEncoding } from 'js-tiktoken';
import { createBuiltinCatalog } from '@wrenyard/providers';
import type { ModelDefinition, ThinkingLevel } from '@wrenyard/providers/base';
import { models as registeredModels } from '@wrenyard/models';
import type { DriverResult, ModelDriver, ModelMessage, Usage } from './driver.js';

export type { ModelMessage, Usage } from './driver.js';

/** Every role that may issue a call. `reason` is the one expensive role. */
export const CALL_ROLES = ['reason', 'select', 'interpret', 'compile', 'write', 'reply', 'title'] as const;
export type CallRole = (typeof CALL_ROLES)[number];

/** The expensive role streams with no total deadline; its idle stream is bounded. */
export const REASON_IDLE_TIMEOUT_MS = 180_000;
/** A write-doc call is bounded end to end. */
export const WRITE_TIMEOUT_MS = 180_000;
/** Every other cheap call is bounded end to end. */
export const CHEAP_TIMEOUT_MS = 60_000;

/** Caller-supplied expensive model for the `reason` role. */
export interface ReasonSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

/** Model facts used by the budget check and by the `<wy-info>` view. */
export interface ModelMetadata {
  contextWindow?: number;
  maxOutputTokens?: number;
  thinkingLevels?: readonly ThinkingLevel[];
}

/**
 * The `call` ledger event body. `seq` and `at` are assigned by the ledger on
 * append, so the runner hands over everything else through a structural
 * callback and never imports the ledger module.
 */
export interface CallEventDraft {
  type: 'call';
  callId: string;
  role: CallRole;
  /** Gateway public id, always exactly `provider/model`. */
  model: string;
  status: 'ok' | 'failed' | 'aborted';
  startedAt: string;
  endedAt: string;
  /** When the driver first produced a nonempty delta (visible or reasoning). */
  firstTokenAt?: string;
  /** Character count per prompt layer, e.g. `{ 'wy-system': 1234 }`. */
  layers: Record<string, number>;
  estimatedInputTokens: number;
  usage?: Usage;
  /** Visible output; partial output when the call was aborted or interrupted. */
  output: string;
  reasoning?: string;
  error?: string;
  turn?: number;
  cycle?: number;
}

/**
 * The `call.started` event body, written as the call is actually issued. It is
 * observational: it never enters the rendered context, so appending it cannot
 * change any previously rendered result. Its `callId` matches the terminal
 * `call` event for the same attempt.
 */
export interface CallStartedEventDraft {
  type: 'call.started';
  callId: string;
  role: CallRole;
  /** Gateway public id, always exactly `provider/model`. */
  model: string;
  turn?: number;
  cycle?: number;
}

/** Every ledger draft the runner writes for one call. */
export type CallLedgerEventDraft = CallStartedEventDraft | CallEventDraft;

export interface ModelCallInput {
  callId: string;
  role: CallRole;
  turn?: number;
  cycle?: number;
  /** Fully assembled request messages, supplied by the caller's view. */
  messages: readonly ModelMessage[];
  /** Character count per assembled prompt layer. */
  layers: Record<string, number>;
  /** Required for `reason`; ignored for every other role. */
  reason?: ReasonSelection;
  signal: AbortSignal;
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
}

export interface ModelCallOutput {
  model: string;
  text: string;
  reasoning?: string;
  usage?: Usage;
}

export interface CallRunnerOptions {
  driver: ModelDriver;
  /** Cheap model public id used by every role except `reason`. */
  cheapModel: () => string | Promise<string>;
  /** Structural sink: exactly one terminal call event per attempted invocation. */
  append: (event: CallLedgerEventDraft) => void | Promise<void>;
  now?: () => Date;
}

export interface CallRunner {
  run(input: ModelCallInput): Promise<ModelCallOutput>;
}

/** Raised after the call event has been written; carries the partial output. */
export class ModelCallError extends Error {
  constructor(
    message: string,
    readonly detail: {
      callId: string;
      role: CallRole;
      model: string;
      status: 'failed' | 'aborted';
      partialText: string;
      partialReasoning?: string;
    },
  ) {
    super(message);
    this.name = 'ModelCallError';
  }
}

let tokenizer: ReturnType<typeof getEncoding> | undefined;

/** `cl100k_base` token count estimate of one text. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  tokenizer ??= getEncoding('cl100k_base');
  return tokenizer.encode(text).length;
}

/** `cl100k_base` token count estimate of a supplied message list. */
export function estimateInputTokens(messages: readonly ModelMessage[]): number {
  let total = 0;
  for (const message of messages) total += estimateTokens(message.role) + estimateTokens(message.content);
  return total;
}

let catalog: ReturnType<typeof createBuiltinCatalog> | undefined;

function builtinCatalog(): ReturnType<typeof createBuiltinCatalog> {
  catalog ??= createBuiltinCatalog();
  return catalog;
}

/**
 * Model metadata for one `provider/model` public id. The built-in provider
 * catalog is authoritative; a field the provider module leaves undeclared is
 * completed from the canonical model in the `@wrenyard/models` registry. A
 * field neither source declares stays undefined, and the budget check is then
 * skipped instead of being invented.
 */
export function resolveModelMetadata(publicId: string): ModelMetadata {
  const separator = publicId.indexOf('/');
  if (separator <= 0 || separator === publicId.length - 1) return {};
  const providerId = publicId.slice(0, separator);
  const requestedModelId = publicId.slice(separator + 1);
  const provider = builtinCatalog().provider(providerId);
  const modelId = provider?.modelAliases?.[requestedModelId] ?? requestedModelId;
  const definition: ModelDefinition | undefined = provider?.models.find((entry) => entry.id === modelId);
  const defaults = registeredModels.get(definition?.canonicalModel?.id ?? modelId)?.defaults;
  const contextWindow = definition?.contextWindow ?? defaults?.contextWindow;
  const maxOutputTokens = definition?.maxOutputTokens ?? defaults?.maxOutputTokens;
  const thinkingLevels = definition?.thinkingLevels ?? defaults?.thinkingLevels;
  return {
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(thinkingLevels === undefined ? {} : { thinkingLevels }),
  };
}

export interface ContextBudget {
  metadata: ModelMetadata;
  estimatedInputTokens: number;
  /** True when the call may be sent. */
  ok: boolean;
  /** Why the call may not be sent; absent when `ok`. */
  reason?: string;
}

/**
 * Context budget check. The model maximum is the only limit — there is no
 * extra soft budget — and a call is refused when the estimate plus the model's
 * output allowance would exceed its window.
 */
export function checkContextBudget(publicId: string, messages: readonly ModelMessage[]): ContextBudget {
  const metadata = resolveModelMetadata(publicId);
  const estimatedInputTokens = estimateInputTokens(messages);
  if (metadata.contextWindow === undefined || metadata.maxOutputTokens === undefined) {
    return { metadata, estimatedInputTokens, ok: true };
  }
  const total = estimatedInputTokens + metadata.maxOutputTokens;
  if (total > metadata.contextWindow) {
    return {
      metadata,
      estimatedInputTokens,
      ok: false,
      reason: `Estimated input ${estimatedInputTokens} + max output ${metadata.maxOutputTokens} exceeds the context window ${metadata.contextWindow}`,
    };
  }
  return { metadata, estimatedInputTokens, ok: true };
}

/**
 * True only when the model definition declares the level as a legal thinking
 * level. An undeclared list is not a licence to accept an arbitrary string.
 */
export function isThinkingLevelSupported(metadata: ModelMetadata, level: string): boolean {
  return metadata.thinkingLevels?.some((candidate) => candidate === level) ?? false;
}

/** Reject promptly when the signal aborts, even while awaiting a plain promise. */
function settleWithAbort<T>(value: T | Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(value).then(
      (resolved) => {
        signal.removeEventListener('abort', onAbort);
        resolve(resolved);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function abortError(): Error {
  const error = new Error('Model call was aborted');
  error.name = 'AbortError';
  return error;
}

/** Human-readable failure message for one abort cause. */
function abortMessage(kind: 'signal' | 'timeout' | 'idle' | undefined, totalTimeoutMs: number | undefined): string {
  if (kind === 'timeout') return `Call timed out after ${totalTimeoutMs} ms`;
  if (kind === 'idle') return `Reasoning stalled: no output for ${REASON_IDLE_TIMEOUT_MS} ms`;
  if (kind === 'signal') return 'Model call was aborted';
  return 'Model call failed';
}

/** Create the role-aware call runner. */
export function createCallRunner(options: CallRunnerOptions): CallRunner {
  const now = options.now ?? ((): Date => new Date());

  return {
    async run(input: ModelCallInput): Promise<ModelCallOutput> {
      const startedAt = now().toISOString();
      let model = '';
      let estimatedInputTokens = 0;
      let reasoningEffort: string | undefined;
      let partialUsage: Usage | undefined;
      let emitted = false;
      /** First nonempty delta time, shared by the terminal call event. */
      let firstTokenAt: string | undefined;

      const emit = async (
        status: CallEventDraft['status'],
        fields: { output: string; reasoning?: string; usage?: Usage; error?: string; firstTokenAt?: string },
      ): Promise<void> => {
        if (emitted) return;
        emitted = true;
        await options.append({
          type: 'call',
          callId: input.callId,
          role: input.role,
          model,
          status,
          startedAt,
          endedAt: now().toISOString(),
          layers: input.layers,
          estimatedInputTokens,
          ...(fields.usage === undefined ? {} : { usage: fields.usage }),
          ...(fields.firstTokenAt === undefined ? {} : { firstTokenAt: fields.firstTokenAt }),
          output: fields.output,
          ...(fields.reasoning === undefined ? {} : { reasoning: fields.reasoning }),
          ...(fields.error === undefined ? {} : { error: fields.error }),
          ...(input.turn === undefined ? {} : { turn: input.turn }),
          ...(input.cycle === undefined ? {} : { cycle: input.cycle }),
        });
      };
      /** Write the single `call` event for this attempt, then throw. */
      const fail = async (
        message: string,
        detail: {
          status?: 'failed' | 'aborted';
          partialText?: string;
          partialReasoning?: string;
          usage?: Usage;
        } = {},
      ): Promise<never> => {
        const status = detail.status ?? 'failed';
        const partialText = detail.partialText ?? '';
        await emit(status, {
          output: partialText,
          ...(detail.partialReasoning === undefined ? {} : { reasoning: detail.partialReasoning }),
          ...(detail.usage === undefined ? {} : { usage: detail.usage }),
          ...(firstTokenAt === undefined ? {} : { firstTokenAt }),
          error: message,
        });
        throw new ModelCallError(message, {
          callId: input.callId,
          role: input.role,
          model,
          status,
          partialText,
          ...(detail.partialReasoning === undefined ? {} : { partialReasoning: detail.partialReasoning }),
        });
      };

      // Timers and abort wiring come first so the total deadline also covers
      // cheap-model resolution and driver acquisition.
      const controller = new AbortController();
      let abortKind: 'signal' | 'timeout' | 'idle' | undefined;
      const abort = (kind: 'signal' | 'timeout' | 'idle'): void => {
        abortKind ??= kind;
        controller.abort();
      };
      const onExternalAbort = (): void => abort('signal');
      if (input.signal.aborted) abort('signal');
      else input.signal.addEventListener('abort', onExternalAbort, { once: true });

      const totalTimeoutMs = input.role === 'reason'
        ? undefined
        : input.role === 'write' ? WRITE_TIMEOUT_MS : CHEAP_TIMEOUT_MS;
      const totalTimer = totalTimeoutMs === undefined
        ? undefined
        : setTimeout(() => abort('timeout'), totalTimeoutMs);
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const resetIdle = (): void => {
        if (input.role !== 'reason') return;
        if (idleTimer !== undefined) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => abort('idle'), REASON_IDLE_TIMEOUT_MS);
      };
      resetIdle();

      let text = '';
      let reasoning = '';
      const onText = (delta: string): void => {
        text += delta;
        if (delta !== '') {
          firstTokenAt ??= now().toISOString();
          resetIdle();
        }
        input.onText?.(delta);
      };
      const onReasoning = (delta: string): void => {
        reasoning += delta;
        if (delta !== '') {
          firstTokenAt ??= now().toISOString();
          resetIdle();
        }
        input.onReasoning?.(delta);
      };

      let result: DriverResult | undefined;
      try {
        if (input.role === 'reason') {
          const selection = input.reason;
          if (!selection) return await fail('The reason role requires a model selection');
          model = `${selection.provider}/${selection.model}`;
          reasoningEffort = selection.reasoningEffort;
        } else {
          model = await settleWithAbort(options.cheapModel(), controller.signal);
        }
        if (controller.signal.aborted) {
          return await fail(abortMessage(abortKind, totalTimeoutMs), {
            status: abortKind === 'signal' ? 'aborted' : 'failed',
          });
        }

        const budget = checkContextBudget(model, input.messages);
        estimatedInputTokens = budget.estimatedInputTokens;
        if (input.role === 'reason' && reasoningEffort !== undefined
          && !isThinkingLevelSupported(budget.metadata, reasoningEffort)) {
          return await fail(`Model ${model} does not support reasoning effort "${reasoningEffort}"`);
        }
        if (!budget.ok) return await fail(`Call not sent: ${budget.reason}`);

        // Observational marker: the driver call is about to be issued. It never
        // enters the rendered context, so it cannot change prior renderings.
        await options.append({
          type: 'call.started',
          callId: input.callId,
          role: input.role,
          model,
          ...(input.turn === undefined ? {} : { turn: input.turn }),
          ...(input.cycle === undefined ? {} : { cycle: input.cycle }),
        });

        result = await settleWithAbort(options.driver.complete({
          model,
          messages: input.messages,
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
          signal: controller.signal,
          onText,
          onReasoning,
          onUsage: (usage: Usage): void => { partialUsage = usage; },
        }), controller.signal);
      } catch (error) {
        if (error instanceof ModelCallError) throw error;
        const status: 'failed' | 'aborted' = abortKind === 'signal' ? 'aborted' : 'failed';
        const message = abortKind === undefined
          ? error instanceof Error ? error.message : String(error)
          : abortMessage(abortKind, totalTimeoutMs);
        return await fail(message, {
          status,
          partialText: text,
          ...(reasoning === '' ? {} : { partialReasoning: reasoning }),
          ...(partialUsage === undefined ? {} : { usage: partialUsage }),
        });
      } finally {
        if (totalTimer !== undefined) clearTimeout(totalTimer);
        if (idleTimer !== undefined) clearTimeout(idleTimer);
        input.signal.removeEventListener('abort', onExternalAbort);
      }

      const finalText = result ? result.text : text;
      const finalReasoning = result?.reasoning ?? (reasoning || undefined);
      const usage = result?.usage ?? partialUsage;

      await emit('ok', {
        output: finalText,
        ...(finalReasoning === undefined ? {} : { reasoning: finalReasoning }),
        ...(usage === undefined ? {} : { usage }),
        ...(firstTokenAt === undefined ? {} : { firstTokenAt }),
      });

      return {
        model,
        text: finalText,
        ...(finalReasoning === undefined ? {} : { reasoning: finalReasoning }),
        ...(usage === undefined ? {} : { usage }),
      };
    },
  };
}
