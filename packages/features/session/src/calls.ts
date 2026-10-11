/**
 * session model calls.
 *
 * One call is one stateless request: pick the role's model, resolve its model
 * metadata, estimate the input with `cl100k_base`, enforce the context budget,
 * run it through the {@link ModelTransport} under the role's timeout, and write
 * exactly one `call` ledger event for the attempt. The runner keeps no session
 * state, never parses JSON output and never repairs schemas — those belong to
 * `actions.ts` / `engine.ts`.
 *
 * The transport owns the only same-route retry and the protocol adapters. The
 * runner performs no failover: the main reasoning call keeps the user's model,
 * and an auxiliary call keeps the one route it selected after skipping blocked
 * routes, failing on the selected route instead of switching to another.
 */
import { getEncoding } from 'js-tiktoken';
import type { GatewayRouteStatus, ProviderDefinition } from '@wrenyard/providers/base';
import type { ReasoningEffort } from '@wrenyard/models';
import {
  abortError,
  isContextOverflowError,
  type ModelAttempts,
  type ModelContentPart,
  type ModelErrorKind,
  type ModelEvent,
  type ModelResult,
  type ModelTransport,
  type RetryAfterHint,
  type ToolCall,
  type ToolSpec,
  type TpsSample,
  type Usage,
} from './transport/index.ts';
import { ROLE_REQUIREMENTS, type AuxiliaryCallRole } from './role-requirements.js';
import { resolveModelMetadata, type ModelMetadata } from './model-metadata.ts';

// The pure metadata helper now lives in the browser-safe model-metadata entry;
// the call runner re-exports it so existing `./calls.ts` consumers are unchanged.
export { resolveModelMetadata } from './model-metadata.ts';
export type { ModelMetadata } from './model-metadata.ts';

export type { Message, ModelContentPart, ToolCall, ToolSpec, Usage } from './transport/index.ts';

/** Every role that may issue a call. `reason` is the one expensive role. */
export const CALL_ROLES = ['reason', 'memory-search', 'search', 'dispatch', 'reply', 'title', 'document', 'vcs', 'project'] as const;
export type CallRole = (typeof CALL_ROLES)[number];

/** The expensive role streams with no total deadline; its idle stream is bounded. */
export const REASON_IDLE_TIMEOUT_MS = 180_000;
/** Every cheap call is bounded end to end. */
export const CHEAP_TIMEOUT_MS = 60_000;

/** Caller-supplied expensive model for the `reason` role. */
export interface ReasonSelection {
  provider: string;
  model: string;
  /** Explicit public reasoning level; required for the `reason` role. */
  reasoningEffort: ReasoningEffort;
}

/** Structured failure fact recorded on a `call` event and handed to reply. */
export interface CallErrorFact {
  kind: ModelErrorKind;
  status?: number;
  /** Supplier's original message. */
  message: string;
}

/** One same-route transport retry, recorded in order. */
export interface CallRetry {
  status?: number;
  kind: ModelErrorKind;
  delayMs: number;
  /** Present only when the upstream retry hint was actually adopted. */
  retryAfter?: RetryAfterHint;
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
  /** Rank of the route that served (or last attempted) an auxiliary call. */
  selectedRank?: number;
  /** Ordered auxiliary routes retained for this invocation. */
  routeCandidates?: readonly AuxiliaryRoute[];
  /** Structured failure fact; present only when the attempt failed. */
  error?: CallErrorFact;
  /** Each same-route transport retry, in order. */
  retries?: readonly CallRetry[];
  /**
   * Tokenizer_v1 speed sample of this call. Present only when the successful
   * transport result carried one; never derived from official usage or local
   * first-token timing, and absent on failures and legacy records.
   */
  tps?: TpsSample;
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
  messages: readonly import('./transport/index.ts').Message[];
  /** Character count per assembled prompt layer. */
  layers: Record<string, number>;
  /** Required for `reason`; ignored for every other role. */
  reason?: ReasonSelection;
  /** Output-token cap forwarded as the protocol's own token field when set. */
  maxTokens?: number;
  signal: AbortSignal;
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  /** Forwarded to the driver for every role. */
  onToolCall?: (call: ToolCall) => void;
  /** Tools declared on this call; forwarded to the driver for every role. */
  tools?: readonly ToolSpec[];
}

export interface ModelCallOutput {
  model: string;
  /** Visible text. */
  text: string;
  reasoning?: string;
  usage?: Usage;
  /** Native tool calls the model returned, in call order; empty when it returned none. */
  toolCalls: ToolCall[];
  finishReason?: import('./transport/index.ts').FinishReason;
}

/** One ranked auxiliary route and the level it is called at. */
export interface AuxiliaryRoute { model: string; reasoningEffort: ReasoningEffort; }

export interface CallRunnerOptions {
  resolveProvider?: (providerId: string) => ProviderDefinition | undefined;
  /** The one unified transport every role calls. */
  transport: ModelTransport;
  /** Current Gateway state of a route; a provider or pool failure can block sibling routes. */
  routeStatus?: (model: string) => GatewayRouteStatus | undefined;
  /** Session id, sent to the Gateway for request attribution. */
  sessionId?: string;
  /** Fresh non-empty ranked routes for each auxiliary invocation. */
  selectAuxiliary: (role: AuxiliaryCallRole) => readonly AuxiliaryRoute[] | Promise<readonly AuxiliaryRoute[]>;
  /** Structural sink: exactly one terminal call event per attempted invocation. */
  append: (event: CallLedgerEventDraft) => void | Promise<void>;
  /** Forwarded as the request cache key on every call of this runner. */
  cacheKey?: string;
  now?: () => Date;
}

export interface CallRunner {
  run(input: ModelCallInput): Promise<ModelCallOutput>;
}

/** Raised after the call event has been written; carries the partial output and failure facts. */
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
      /** Structured failure fact for the reply view. */
      failure?: CallErrorFact;
      /** Attempt statistics of the failed call. */
      attempts?: ModelAttempts;
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
export function estimateInputTokens(messages: readonly import('./transport/index.ts').Message[]): number {
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
export function sanitizeMessagesForRole(
  role: CallRole,
  messages: readonly import('./transport/index.ts').Message[],
): readonly import('./transport/index.ts').Message[] {
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
export function checkContextBudget(publicId: string, messages: readonly import('./transport/index.ts').Message[], resolveProvider?: (providerId: string) => ProviderDefinition | undefined): ContextBudget {
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

/** Build the structured failure fact of a thrown transport error. */
function errorFactOf(error: unknown): CallErrorFact {
  if (error instanceof Error && 'kind' in error && typeof (error as { kind?: unknown }).kind === 'string') {
    const typed = error as { kind: ModelErrorKind; status?: number; message: string };
    return { kind: typed.kind, ...(typed.status === undefined ? {} : { status: typed.status }), message: typed.message };
  }
  return { kind: 'protocol', message: error instanceof Error ? error.message : String(error) };
}

/** Attempt statistics of a thrown transport error, when it carries them. */
function attemptsOf(error: unknown): ModelAttempts | undefined {
  return error instanceof Error && 'attempts' in error
    ? (error as { attempts?: ModelAttempts }).attempts
    : undefined;
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
      let routes: readonly AuxiliaryRoute[] | undefined;
      let selectedRank: number | undefined;
      const retries: CallRetry[] = [];
      let partialUsage: Usage | undefined;
      let emitted = false;
      /** First nonempty delta time, shared by the terminal call event. */
      let firstTokenAt: string | undefined;

      const emit = async (
        status: CallEventDraft['status'],
        fields: { output: string; reasoning?: string; usage?: Usage; error?: CallErrorFact; firstTokenAt?: string; tps?: TpsSample },
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
          ...(routes === undefined ? {} : { routeCandidates: routes }),
          ...(selectedRank === undefined ? {} : { selectedRank }),
          ...(retries.length ? { retries } : {}),
          ...(requestedReasoningEffort === undefined ? {} : { requestedReasoningEffort }),
          ...(fields.error === undefined ? {} : { error: fields.error }),
          ...(fields.tps === undefined ? {} : { tps: fields.tps }),
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
          error?: CallErrorFact;
          attempts?: ModelAttempts;
        } = {},
      ): Promise<never> => {
        const status = detail.status ?? 'failed';
        const partialText = detail.partialText ?? '';
        const failure = detail.error ?? { kind: 'protocol' as ModelErrorKind, message };
        await emit(status, {
          output: partialText,
          ...(detail.partialReasoning === undefined ? {} : { reasoning: detail.partialReasoning }),
          ...(detail.usage === undefined ? {} : { usage: detail.usage }),
          ...(firstTokenAt === undefined ? {} : { firstTokenAt }),
          error: failure,
        });
        throw new ModelCallError(message, {
          callId: input.callId,
          role: input.role,
          model,
          status,
          partialText,
          ...(detail.partialReasoning === undefined ? {} : { partialReasoning: detail.partialReasoning }),
          failure,
          ...(detail.attempts === undefined ? {} : { attempts: detail.attempts }),
        });
      };

      // Timers and abort wiring come first so the total deadline also covers
      // auxiliary route selection and driver acquisition.
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

      let outputStarted = false;
      const onOutput = (): void => { outputStarted = true; firstTokenAt ??= now().toISOString(); resetIdle(); };
      let text = '';
      let reasoning = '';
      const onText = (delta: string): void => {
        text += delta;
        if (delta !== '') onOutput();
        input.onText?.(delta);
      };
      const onReasoning = (delta: string): void => {
        reasoning += delta;
        if (delta !== '') onOutput();
        input.onReasoning?.(delta);
      };
      /** Map one transport event onto the runner's output and activity tracking. */
      const onEvent = (event: ModelEvent): void => {
        switch (event.type) {
          case 'text': onText(event.delta); return;
          case 'reasoning': onReasoning(event.delta); return;
          case 'tool_call': onOutput(); input.onToolCall?.(event.call); return;
          case 'usage': partialUsage = event.usage; return;
          case 'activity': resetIdle(); return;
          case 'retry':
            retries.push({
              kind: event.kind,
              delayMs: event.delayMs,
              ...(event.status === undefined ? {} : { status: event.status }),
              // Recorded only when the upstream hint was actually adopted; a pure
              // exponential-backoff retry carries no retryAfter.
              ...(event.retryAfter === undefined ? {} : { retryAfter: event.retryAfter }),
            });
            // A retry wait is activity: it must not trip the idle timer.
            resetIdle();
            return;
        }
      };

      let result: ModelResult | undefined;
      try {
        if (input.role === 'reason') {
          const selection = input.reason;
          if (!selection) return await fail('The reason role requires a model selection');
          model = `${selection.provider}/${selection.model}`;
          requestedReasoningEffort = selection.reasoningEffort;
        } else {
          requestedReasoningEffort = ROLE_REQUIREMENTS[input.role].expectedReasoningEffort[0];
          routes = await settleWithAbort(options.selectAuxiliary(input.role), controller.signal);
          if (!routes.length) throw new Error(`Auxiliary role ${input.role}: no candidate qualified (empty route selection)`);
          selectedRank = 1;
          model = routes[0]!.model;
        }
        if (controller.signal.aborted) {
          return await fail(abortMessage(abortKind, totalTimeoutMs), {
            status: abortKind === 'signal' ? 'aborted' : 'failed',
          });
        }

        // The main reasoning call is explicit and never switches; an auxiliary
        // call keeps the one route it selected after skipping blocked routes.
        const choices: readonly AuxiliaryRoute[] = input.role === 'reason'
          ? [{ model, reasoningEffort: requestedReasoningEffort as ReasoningEffort }]
          : routes!;
        const choice = choices.find((candidate) => input.role === 'reason'
          || options.routeStatus?.(candidate.model) === undefined);
        if (choice === undefined) throw new Error(`Model call ${input.role} failed: every candidate route is blocked`);
        const rank = input.role === 'reason' ? undefined : choices.indexOf(choice) + 1;
        model = choice.model;
        selectedRank = rank;
        const budget = checkContextBudget(model, messages, options.resolveProvider);
        estimatedInputTokens = budget.estimatedInputTokens;
        if (!isReasoningEffortSupported(budget.metadata, choice.reasoningEffort)) {
          return await fail(`Model ${model} does not support reasoning effort "${choice.reasoningEffort ?? ''}"`);
        }
        actualReasoningEffort = choice.reasoningEffort;
        if (!budget.ok) return await fail(`context_overflow: ${budget.reason}`);
        await options.append({ type: 'call.started', callId: input.callId, role: input.role, model,
          ...(input.turn === undefined ? {} : { turn: input.turn }),
          ...(input.cycle === undefined ? {} : { cycle: input.cycle }) });
        result = await settleWithAbort(options.transport.complete({
          model,
          messages,
          reasoningEffort: actualReasoningEffort,
          attribution: { role: input.role, ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }) },
          ...(options.cacheKey === undefined ? {} : { cacheKey: options.cacheKey }),
          ...(input.maxTokens === undefined ? {} : { maxOutputTokens: input.maxTokens }),
          ...(input.tools === undefined ? {} : { tools: input.tools }),
          signal: controller.signal,
          onEvent,
        }), controller.signal);
      } catch (error) {
        if (error instanceof ModelCallError) throw error;
        const status: 'failed' | 'aborted' = abortKind === 'signal' ? 'aborted' : 'failed';
        const message = abortKind === undefined
          ? withOverflowPrefix(error)
          : abortMessage(abortKind, totalTimeoutMs);
        const errorFact = abortKind === undefined ? errorFactOf(error) : { kind: 'aborted' as ModelErrorKind, message };
        return await fail(message, {
          status,
          partialText: text,
          ...(reasoning === '' ? {} : { partialReasoning: reasoning }),
          ...(partialUsage === undefined ? {} : { usage: partialUsage }),
          error: errorFact,
          ...(attemptsOf(error) === undefined ? {} : { attempts: attemptsOf(error)! }),
        });
      } finally {
        if (totalTimer !== undefined) clearTimeout(totalTimer);
        if (idleTimer !== undefined) clearTimeout(idleTimer);
        input.signal.removeEventListener('abort', onExternalAbort);
      }

      // Visible text only; native tool calls are returned separately.
      const finalText = result ? result.text : text;
      const finalReasoning = result?.reasoning ?? (reasoning || undefined);
      const usage = result?.usage ?? partialUsage;

      await emit('ok', {
        output: finalText,
        ...(finalReasoning === undefined ? {} : { reasoning: finalReasoning }),
        ...(usage === undefined ? {} : { usage }),
        ...(firstTokenAt === undefined ? {} : { firstTokenAt }),
        // The successful result's optional sample is the only TPS recorded; a
        // transport failure never produces one.
        ...(result?.tps === undefined ? {} : { tps: result.tps }),
      });

      return {
        model,
        text: finalText,
        ...(finalReasoning === undefined ? {} : { reasoning: finalReasoning }),
        ...(usage === undefined ? {} : { usage }),
        toolCalls: result?.toolCalls ?? [],
        ...(result?.finishReason === undefined ? {} : { finishReason: result.finishReason }),
      };
    },
  };
}
