/**
 * session model calls.
 *
 * One call is one stateless request: pick the role's model, resolve its model
 * metadata, estimate the input with `o200k_base`, enforce the context budget,
 * run it through the {@link ModelTransport} under the role's timeout, and write
 * exactly one `span.started` and one `span.finished` ledger event for the
 * invocation. The runner keeps no session state, never parses JSON output and
 * never repairs schemas — those belong to `actions.ts` / `engine.ts`.
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
  type ModelContentPart,
  type ModelErrorKind,
  type ModelEvent,
  type ModelMetrics,
  type ModelResult,
  type ModelTransport,
  type ToolCall,
  type ToolSpec,
  type ToolChoice,
  type Usage,
} from '../transport/index.ts';
import type { ModelSpanFinishedEvent, ModelSpanStartedEvent } from '../ledger/events.ts';
import { ROLE_REQUIREMENTS, type AuxiliaryCallRole } from './roles.ts';
import { resolveModelMetadata, type ModelMetadata } from './metadata.ts';

// The pure metadata helper now lives in the browser-safe model-metadata entry;
// the call runner re-exports it so existing `./calls.ts` consumers are unchanged.
export { resolveModelMetadata } from './metadata.ts';
export type { ModelMetadata } from './metadata.ts';

export type { Message, ModelContentPart, ToolCall, ToolSpec, Usage } from '../transport/index.ts';

/** Every role that may issue a call. `reason` is the one expensive role. */
export const CALL_ROLES = ['reason', 'memory-search', 'search', 'dispatch', 'reply', 'title', 'document', 'vcs', 'project', 'status'] as const;
export type CallRole = (typeof CALL_ROLES)[number];

/** The expensive role streams with no total deadline; its idle stream is bounded. */
export const REASON_IDLE_TIMEOUT_MS = 180_000;
/** Every auxiliary request is bounded end to end. */
export const AUXILIARY_TIMEOUT_MS = 60_000;

/** Caller-supplied expensive model for the `reason` role. */
export interface ReasonSelection {
  provider: string;
  model: string;
  /** Explicit public reasoning level; required for the `reason` role. */
  reasoningEffort: ReasoningEffort;
}

/** Structured failure fact recorded on a failed span and handed to reply. */
export interface CallErrorFact {
  kind: ModelErrorKind;
  status?: number;
  /** Supplier's original message. */
  message: string;
}

/**
 * Every span event draft the runner writes for one invocation. `seq` and `at`
 * are assigned by the ledger on append, so the runner hands over everything
 * else through a structural callback and never imports the ledger store.
 */
export type SpanEventDraft =
  | Omit<ModelSpanStartedEvent, 'seq' | 'at'>
  | Omit<ModelSpanFinishedEvent, 'seq' | 'at'>;

export interface ModelCallInput {
  spanId: string;
  /** The owning step for a reasoning span, or the owning action for an auxiliary span. */
  parent: string;
  role: CallRole;
  turn?: number;
  step?: number;
  /** Fully assembled request messages, supplied by the caller's view. */
  messages: readonly import('../transport/index.ts').Message[];
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
  toolChoice?: ToolChoice;
}

export interface ModelCallOutput {
  model: string;
  /** Visible text. */
  text: string;
  reasoning?: string;
  usage?: Usage;
  /** Native tool calls the model returned, in call order; empty when it returned none. */
  toolCalls: ToolCall[];
  finishReason?: import('../transport/index.ts').FinishReason;
  /** Measured facts of the call, produced by the transport. */
  metrics: ModelMetrics;
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
  /** Structural sink: the span events of every attempted invocation, in order. */
  append: (event: SpanEventDraft) => void | Promise<void>;
  /** Forwarded as the request cache key on every call of this runner. */
  cacheKey?: string;
  now?: () => Date;
}

export interface CallRunner {
  run(input: ModelCallInput): Promise<ModelCallOutput>;
}

/** Raised after the failure span has been written; carries the failure facts. */
export class ModelCallError extends Error {
  constructor(
    message: string,
    readonly detail: {
      spanId: string;
      role: CallRole;
      model: string;
      status: 'failed' | 'aborted';
      /** Structured failure fact for the reply view. */
      failure?: CallErrorFact;
      /** Measured facts of the failed call, produced by the transport. */
      metrics?: ModelMetrics;
    },
  ) {
    super(message);
    this.name = 'ModelCallError';
  }
}

let tokenizer: ReturnType<typeof getEncoding> | undefined;

/** Fallback per-image input-token estimate when only a data URL is available. */
export const IMAGE_INPUT_TOKEN_ESTIMATE = 1_200;

/** `o200k_base` token count estimate of one text. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  tokenizer ??= getEncoding('o200k_base');
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

/** `o200k_base` token count estimate of a supplied message list. */
export function estimateInputTokens(messages: readonly import('../transport/index.ts').Message[]): number {
  let total = 0;
  for (const message of messages) total += estimateTokens(message.role) + estimateContentTokens(message.content);
  return total;
}

/**
 * Defense in depth: only the main reasoning role may carry image bytes. For any
 * other role every `image_url` part is replaced by a textual omitted descriptor
 * before the budget check and the driver, so a auxiliary request can never transmit
 * image content.
 */
export function sanitizeMessagesForRole(
  role: CallRole,
  messages: readonly import('../transport/index.ts').Message[],
): readonly import('../transport/index.ts').Message[] {
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
export function checkContextBudget(publicId: string, messages: readonly import('../transport/index.ts').Message[], resolveProvider?: (providerId: string) => ProviderDefinition | undefined): ContextBudget {
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

/** Measured facts of a thrown transport error, when it carries them. */
function metricsOf(error: unknown): ModelMetrics | undefined {
  return error instanceof Error && 'metrics' in error
    ? (error as { metrics?: ModelMetrics }).metrics
    : undefined;
}

/** Create the role-aware call runner. */
export function createCallRunner(options: CallRunnerOptions): CallRunner {
  return {
    async run(input: ModelCallInput): Promise<ModelCallOutput> {
      // Non-reasoning roles never transmit image bytes: image parts become a
      // textual omitted descriptor before the budget check and the driver.
      const messages = sanitizeMessagesForRole(input.role, input.messages);
      const spanKind: 'reasoning' | 'auxiliary' = input.role === 'reason' ? 'reasoning' : 'auxiliary';
      let model = '';
      let estimatedInputTokens = 0;
      let actualReasoningEffort: ReasoningEffort | undefined;
      let requestedReasoningEffort: string | undefined;
      let auxiliaryRole: AuxiliaryCallRole | undefined;
      let routes: readonly AuxiliaryRoute[] | undefined;
      let selectedRank: number | undefined;
      let partialUsage: Usage | undefined;
      let emitted = false;

      /** Append the single `span.finished` event of this invocation. */
      const finish = async (
        status: 'ok' | 'failed' | 'aborted',
        fields: { output?: string; reasoning?: string; error?: CallErrorFact; metrics?: ModelMetrics },
      ): Promise<void> => {
        if (emitted) return;
        emitted = true;
        await options.append({
          type: 'span.finished',
          id: input.spanId,
          kind: spanKind,
          ...(input.turn === undefined ? {} : { turn: input.turn }),
          ...(input.step === undefined ? {} : { step: input.step }),
          status,
          ...(fields.output === undefined ? {} : { output: fields.output }),
          ...(fields.reasoning === undefined ? {} : { reasoning: fields.reasoning }),
          ...(fields.error === undefined ? {} : { error: fields.error }),
          ...(fields.metrics === undefined ? {} : { metrics: fields.metrics }),
        });
      };
      /** Write the failure span event for this invocation, then throw. */
      const fail = async (
        message: string,
        detail: { status?: 'failed' | 'aborted'; error?: CallErrorFact; metrics?: ModelMetrics } = {},
      ): Promise<never> => {
        const status = detail.status ?? 'failed';
        const failure = detail.error ?? { kind: 'protocol' as ModelErrorKind, message };
        await finish(status, {
          error: failure,
          ...(detail.metrics === undefined ? {} : { metrics: detail.metrics }),
        });
        throw new ModelCallError(message, {
          spanId: input.spanId,
          role: input.role,
          model,
          status,
          failure,
          ...(detail.metrics === undefined ? {} : { metrics: detail.metrics }),
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

      const totalTimeoutMs = input.role === 'reason' ? undefined : AUXILIARY_TIMEOUT_MS;
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
      const onOutput = (): void => { outputStarted = true; resetIdle(); };
      const onText = (delta: string): void => {
        if (delta !== '') onOutput();
        input.onText?.(delta);
      };
      const onReasoning = (delta: string): void => {
        if (delta !== '') onOutput();
        input.onReasoning?.(delta);
      };
      /** Map one transport event onto the runner's activity tracking. */
      const onEvent = (event: ModelEvent): void => {
        switch (event.type) {
          case 'text': onText(event.delta); return;
          case 'reasoning': onReasoning(event.delta); return;
          case 'tool_call': onOutput(); input.onToolCall?.(event.call); return;
          case 'usage': partialUsage = event.usage; return;
          case 'activity': resetIdle(); return;
          case 'retry':
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
          auxiliaryRole = input.role;
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
        await options.append({
          type: 'span.started',
          id: input.spanId,
          parent: input.parent,
          kind: spanKind,
          ...(input.turn === undefined ? {} : { turn: input.turn }),
          ...(input.step === undefined ? {} : { step: input.step }),
          request: {
            ...(auxiliaryRole === undefined ? {} : { role: auxiliaryRole }),
            model,
            effort: {
              ...(requestedReasoningEffort === undefined ? {} : { requested: requestedReasoningEffort }),
              ...(actualReasoningEffort === undefined ? {} : { sent: actualReasoningEffort }),
            },
            inputEstimate: estimatedInputTokens,
            layers: input.layers,
            ...(routes === undefined || selectedRank === undefined
              ? {}
              : { route: { candidates: routes, rank: selectedRank } }),
          },
        });
        result = await settleWithAbort(options.transport.complete({
          model,
          messages,
          reasoningEffort: actualReasoningEffort,
          attribution: { role: input.role, ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }) },
          ...(options.cacheKey === undefined ? {} : { cacheKey: options.cacheKey }),
          ...(input.maxTokens === undefined ? {} : { maxOutputTokens: input.maxTokens }),
          ...(input.tools === undefined ? {} : { tools: input.tools }),
          ...(input.toolChoice === undefined ? {} : { toolChoice: input.toolChoice }),
          signal: controller.signal,
          onEvent,
        }), controller.signal);
      } catch (error) {
        if (error instanceof ModelCallError) throw error;
        const status: 'failed' | 'aborted' = abortKind === 'signal' ? 'aborted' : 'failed';
        const message = abortKind === undefined
          ? withOverflowPrefix(error)
          : abortMessage(abortKind, totalTimeoutMs);
        const failure = abortKind === undefined ? errorFactOf(error) : { kind: 'aborted' as ModelErrorKind, message };
        const metrics = metricsOf(error);
        return await fail(message, {
          status,
          error: failure,
          ...(metrics === undefined ? {} : { metrics }),
        });
      } finally {
        if (totalTimer !== undefined) clearTimeout(totalTimer);
        if (idleTimer !== undefined) clearTimeout(idleTimer);
        input.signal.removeEventListener('abort', onExternalAbort);
      }

      const completed = result!;
      // Visible text only; native tool calls are returned separately.
      const finalText = completed.text;
      const finalReasoning = completed.reasoning;
      const usage = completed.usage ?? partialUsage;

      await finish('ok', {
        output: finalText,
        ...(finalReasoning === undefined ? {} : { reasoning: finalReasoning }),
        metrics: completed.metrics,
      });

      return {
        model,
        text: finalText,
        ...(finalReasoning === undefined ? {} : { reasoning: finalReasoning }),
        ...(usage === undefined ? {} : { usage }),
        toolCalls: completed.toolCalls,
        ...(completed.finishReason === undefined ? {} : { finishReason: completed.finishReason }),
        metrics: completed.metrics,
      };
    },
  };
}
