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
import type { ProviderDefinition, ModelDefinition } from '@wrenyard/providers/base';
import { models as registeredModels, resolveReasoningEffort, type ReasoningEffort } from '@wrenyard/models';
import { isContextOverflowError } from './driver.js';
import { auxiliaryReasoningRequirement } from './role-requirements.js';
import type { DriverResult, ModelContentPart, ModelDriver, ModelMessage, ToolCall, Usage } from './driver.js';

export type { ModelMessage, Usage } from './driver.js';

/** The shared main-model precedence policy; also served by the model-metadata subpath. */
export { selectInferenceMode } from './inference-mode.js';

/** Every role that may issue a call. `reason` is the one expensive role. */
export const CALL_ROLES = ['reason', 'memory-search', 'doc-search', 'compile', 'reply', 'title'] as const;
export type CallRole = (typeof CALL_ROLES)[number];

/** The expensive role streams with no total deadline; its idle stream is bounded. */
export const REASON_IDLE_TIMEOUT_MS = 180_000;
/** Attempts for one model call when the upstream fails before producing output. */
const TRANSIENT_ATTEMPTS = 3;
const TRANSIENT_BACKOFF_MS = 3_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Upstream 5xx / 429 responses and transport errors; never a client-side 4xx. */
function isTransientFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP (?:5\d\d|429)\b|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|network/iu.test(message);
}
/** Every cheap call is bounded end to end. */
export const CHEAP_TIMEOUT_MS = 60_000;

/** Caller-supplied expensive model for the `reason` role. */
export interface ReasonSelection {
  provider: string;
  model: string;
  /** Explicit public reasoning level; required for the `reason` role. */
  reasoningEffort: ReasoningEffort;
}

/** Model facts used by the budget check and by the `<wy-info>` view. */
export interface ModelMetadata {
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Route-owned reasoning levels this exact model can materialize. */
  reasoningEfforts?: readonly ReasoningEffort[];
  /** True only when the resolved definition declares the `image` capability. */
  imageInput?: boolean;
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
  /** Public reasoning level actually sent on the wire for this attempt. */
  reasoningEffort?: ReasoningEffort;
  /**
   * The effort that was asked for: the explicit level on a `reason` call, or an
   * auxiliary role's declared expectation. Recorded alongside the actual level
   * so a nearest-supported adaptation is visible in the ledger.
   */
  requestedReasoningEffort?: string;
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
  /** Output-token cap forwarded as the wire `max_tokens` when the driver supports it. */
  maxTokens?: number;
  signal: AbortSignal;
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  /** Forwarded to the driver only for `reason`; every other role ignores it. */
  onToolCall?: (call: ToolCall) => void;
}

export interface ModelCallOutput {
  model: string;
  /** Visible text; for `reply`, the text sent through the reply tool (empty when it was not called). */
  text: string;
  reasoning?: string;
  usage?: Usage;
  /** Native tool calls the reason model returned, in call order; empty otherwise. */
  toolCalls: ToolCall[];
}

export interface CallRunnerOptions {
  resolveProvider?: (providerId: string) => ProviderDefinition | undefined;
  driver: ModelDriver;
  /** Cheap model public id used by every role except `reason`. */
  cheapModel: () => string | Promise<string>;
  /** Structural sink: exactly one terminal call event per attempted invocation. */
  append: (event: CallLedgerEventDraft) => void | Promise<void>;
  /** Forwarded as {@link DriverRequest.cacheKey} on every call of this runner. */
  cacheKey?: string;
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

/** Fallback per-image input-token estimate when only a data URL is available. */
export const IMAGE_INPUT_TOKEN_ESTIMATE = 1_200;

/** `cl100k_base` token count estimate of one text. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  tokenizer ??= getEncoding('cl100k_base');
  return tokenizer.encode(text).length;
}

/**
 * Token estimate of one message content. Text parts are counted with the same
 * tokenizer; an image part contributes a fixed processed-image estimate, never
 * the base64 payload length.
 */
export function estimateContentTokens(content: string | readonly ModelContentPart[]): number {
  if (typeof content === 'string') return estimateTokens(content);
  let total = 0;
  for (const part of content) {
    total += part.type === 'text' ? estimateTokens(part.text) : IMAGE_INPUT_TOKEN_ESTIMATE;
  }
  return total;
}

/** `cl100k_base` token count estimate of a supplied message list. */
export function estimateInputTokens(messages: readonly ModelMessage[]): number {
  let total = 0;
  for (const message of messages) total += estimateTokens(message.role) + estimateContentTokens(message.content);
  return total;
}

/**
 * Defense in depth: only the main reasoning role may carry image bytes. For any
 * other role every `image_url` part is replaced by a textual omitted descriptor
 * before the budget check and the driver, so a cheap call can never transmit
 * image content.
 */
export function sanitizeMessagesForRole(role: CallRole, messages: readonly ModelMessage[]): readonly ModelMessage[] {
  if (role === 'reason') return messages;
  let replaced = false;
  const next = messages.map((message) => {
    if (typeof message.content === 'string') return message;
    replaced = true;
    const parts: ModelContentPart[] = message.content.map((part) =>
      part.type === 'text' ? part : { type: 'text', text: '[image omitted: not delivered to a non-reasoning call]' });
    return { ...message, content: parts };
  });
  return replaced ? next : messages;
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
export function resolveModelMetadata(publicId: string, resolveProvider: (providerId: string) => ProviderDefinition | undefined = id => builtinCatalog().provider(id)): ModelMetadata {
  const separator = publicId.indexOf('/');
  if (separator <= 0 || separator === publicId.length - 1) return {};
  const providerId = publicId.slice(0, separator);
  const requestedModelId = publicId.slice(separator + 1);
  const provider = resolveProvider(providerId);
  const modelId = provider?.modelAliases?.[requestedModelId] ?? requestedModelId;
  const definition: ModelDefinition | undefined = provider?.models.find((entry) => entry.id === modelId);
  const defaults = registeredModels.get(definition?.canonicalModel?.id ?? modelId)?.defaults;
  const contextWindow = definition?.contextWindow ?? defaults?.contextWindow;
  const maxOutputTokens = definition?.maxOutputTokens ?? defaults?.maxOutputTokens;
  // Reasoning levels are route-owned: only the resolved provider definition
  // declares them, and the canonical registry never carries an effort list.
  const reasoningEfforts = definition?.reasoningEfforts;
  const imageInput = definition?.capabilities?.some((capability) => capability === 'image');
  return {
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
    ...(imageInput === undefined ? {} : { imageInput }),
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
export function checkContextBudget(publicId: string, messages: readonly ModelMessage[], resolveProvider?: (providerId: string) => ProviderDefinition | undefined): ContextBudget {
  const metadata = resolveModelMetadata(publicId, resolveProvider);
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
 * True only when the route declares the level as a legal reasoning effort. An
 * undeclared list is not a licence to accept an arbitrary level.
 */
export function isReasoningEffortSupported(metadata: ModelMetadata, effort: ReasoningEffort): boolean {
  return metadata.reasoningEfforts?.includes(effort) ?? false;
}

/**
 * The exact public level an auxiliary role should send on one route.
 *
 * The earliest level of the role's declared preference ladder that the route
 * supports is chosen; when no level is shared, the nearest supported level at
 * or above the first preference (else the highest supported level) is used. An
 * unknown role, or a route without a declared ladder, yields undefined.
 */
export function resolveAuxiliaryReasoningEffort(
  role: string,
  supported: readonly ReasoningEffort[] | undefined,
): ReasoningEffort | undefined {
  const expected = auxiliaryReasoningRequirement(role);
  if (expected === undefined || expected.length === 0) return undefined;
  if (supported === undefined || supported.length === 0) return undefined;
  const shared = expected.find((effort) => supported.includes(effort));
  return shared ?? resolveReasoningEffort(expected[0], supported);
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

/**
 * Prefix a failure message with the fixed `context_overflow:` code when it is a
 * context-window overflow, whether it came from the local budget check or an
 * upstream context-too-long error. Desktop matches this prefix and never parses
 * the provider wording.
 */
function withOverflowPrefix(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('context_overflow:')) return message;
  return isContextOverflowError(error) ? `context_overflow: ${message}` : message;
}

/** Create the role-aware call runner. */
export function createCallRunner(options: CallRunnerOptions): CallRunner {
  const now = options.now ?? ((): Date => new Date());

  return {
    async run(input: ModelCallInput): Promise<ModelCallOutput> {
      const startedAt = now().toISOString();
      // Non-reasoning roles never transmit image bytes: image parts become a
      // textual omitted descriptor before the budget check and the driver.
      const messages = sanitizeMessagesForRole(input.role, input.messages);
      let model = '';
      let estimatedInputTokens = 0;
      let actualReasoningEffort: ReasoningEffort | undefined;
      let requestedReasoningEffort: string | undefined;
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
          reasoningEffort: actualReasoningEffort,
          ...(requestedReasoningEffort === undefined ? {} : { requestedReasoningEffort }),
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

      const totalTimeoutMs = input.role === 'reason' ? undefined : CHEAP_TIMEOUT_MS;
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
          requestedReasoningEffort = selection.reasoningEffort;
        } else {
          model = await settleWithAbort(options.cheapModel(), controller.signal);
        }
        if (controller.signal.aborted) {
          return await fail(abortMessage(abortKind, totalTimeoutMs), {
            status: abortKind === 'signal' ? 'aborted' : 'failed',
          });
        }

        const budget = checkContextBudget(model, messages, options.resolveProvider);
        estimatedInputTokens = budget.estimatedInputTokens;
        if (input.role === 'reason') {
          // An explicit level must be exactly materializable by this route. The
          // caller validates against the same route list before forwarding, so
          // an unsupported level is normally rejected even earlier.
          if (requestedReasoningEffort === undefined
            || !isReasoningEffortSupported(budget.metadata, requestedReasoningEffort as ReasoningEffort)) {
            return await fail(`Model ${model} does not support reasoning effort "${requestedReasoningEffort ?? ''}"`);
          }
          actualReasoningEffort = requestedReasoningEffort as ReasoningEffort;
        } else {
          // Auxiliary roles adapt their declared preference onto this route: the
          // earliest shared level, else the nearest supported level.
          requestedReasoningEffort = auxiliaryReasoningRequirement(input.role)?.[0];
          actualReasoningEffort = resolveAuxiliaryReasoningEffort(input.role, budget.metadata.reasoningEfforts);
        }
        if (actualReasoningEffort === undefined) return await fail(`Model ${model} has no reasoning-effort declaration for role ${input.role}`);
        if (!budget.ok) return await fail(`context_overflow: ${budget.reason}`);

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

        // A transient upstream fault before any output is retried in place.
        for (let attempt = 1; ; attempt += 1) {
          try {
            result = await settleWithAbort(options.driver.complete({
              model,
              messages,
              reasoningEffort: actualReasoningEffort,
              ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
              ...(options.cacheKey === undefined ? {} : { cacheKey: options.cacheKey }),
              ...(input.role === 'reason' ? {
                actionTool: true,
                ...(input.onToolCall === undefined ? {} : { onToolCall: input.onToolCall }),
              } : {}),
              ...(input.role === 'reply' ? { replyTool: true } : {}),
              signal: controller.signal,
              onText,
              onReasoning,
              onActivity: resetIdle,
              onUsage: (usage: Usage): void => { partialUsage = usage; },
            }), controller.signal);
            break;
          } catch (error) {
            const retryable = attempt < TRANSIENT_ATTEMPTS && firstTokenAt === undefined
              && !controller.signal.aborted && isTransientFailure(error);
            if (!retryable) throw error;
            await settleWithAbort(delay(TRANSIENT_BACKOFF_MS * attempt), controller.signal);
            resetIdle();
          }
        }
      } catch (error) {
        if (error instanceof ModelCallError) throw error;
        const status: 'failed' | 'aborted' = abortKind === 'signal' ? 'aborted' : 'failed';
        const message = abortKind === undefined
          ? withOverflowPrefix(error)
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

      // A communication call speaks only through its reply tool; content outside
      // it never reaches the user, and no call at all means nothing is sent.
      const finalText = input.role === 'reply'
        ? (result?.replies ?? []).join('\n\n')
        : result ? result.text : text;
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
        toolCalls: result?.toolCalls ?? [],
      };
    },
  };
}
