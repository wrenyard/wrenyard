import type { GatewayProtocol } from '@wrenyard/providers/catalog';
import type { PublicGatewayModel } from '@wrenyard/providers/catalog';
import type { GatewayUsage } from '../response-usage.ts';

export type { GatewayUsage };

/**
 * A passive observer of one successful-status response body. Every protocol
 * module builds its own, so the Gateway's relay never branches on a protocol
 * name.
 */
export interface ResponseObserver {
  /** A non-stream JSON body is complete by itself. */
  json(value: unknown): void;
  feed(chunk: string): void;
  end(): void;
  /** True when the response reached a protocol completion without an error. */
  succeeded(): boolean;
  result(): GatewayUsage | undefined;
  /**
   * The official error identity (`type` / `code`) this response carried, when
   * the protocol module recognized an official error frame. `undefined` means
   * no official error frame was observed; `{}` means one was seen without a
   * usable `type`/`code`. The frames themselves are never rewritten.
   */
  error(): { type?: string; code?: string } | undefined;
}

/**
 * The protocol-neutral sink a protocol module's TPS translator writes into.
 * The module recognizes only its own wire events and reports protocol-neutral
 * facts: one call per nonempty generation delta on a stable, distinct channel,
 * one on the protocol's successful completion (carrying the upstream response
 * identity when the protocol exposes one), and one on any failure. The shared
 * sampler decides whether the sequence yields a sample.
 */
export interface TpsSink {
  delta(channel: string, text: string): void;
  complete(responseId?: string): void;
  fail(): void;
}

/**
 * One protocol module's generation-delta translator. It receives raw response
 * events (the parsed JSON payload, or the Chat `[DONE]` sentinel) and writes
 * only the protocol-neutral generation deltas and outcome signals of
 * {@link TpsSink}. Protocol recognition never leaves the module.
 */
export interface TpsTranslator {
  translate(record: unknown, sink: TpsSink): void;
}

/**
 * Everything protocol-specific about one official entry protocol. The Gateway
 * pipeline and relay call these methods generically; no protocol name is ever
 * tested outside a protocol module.
 */
export interface GatewayProtocolModule {
  readonly protocol: GatewayProtocol;
  /** Model-list path and inference path for this protocol. */
  readonly modelsPath: string;
  readonly inferencePath: string;
  /** The official `/models` response body. */
  listModels(models: PublicGatewayModel[]): unknown;
  /** The protocol's official error envelope, used for Gateway-originated errors. */
  errorEnvelope(type: string, message: string): Record<string, unknown>;
  /** True when a body already is this protocol's official error shape. */
  isOfficialErrorBody(body: unknown): boolean;
  /**
   * True when one parsed event is this protocol's official stream-error frame
   * (the in-stream error forms of Chat, Responses and Messages). Such a frame
   * is forwarded with its exact bytes and is never rewritten.
   */
  isOfficialStreamError(event: unknown): boolean;
  /**
   * The official error `type` this protocol uses for a Gateway-generated
   * status, so the generated envelope carries the entry protocol's own
   * vocabulary rather than a shared one.
   */
  errorTypeForStatus(status: number): string;
  /** Rewrite every response `model` field to the public model id, in place. */
  normalizeResponseModel(payload: unknown, toPublic: (upstreamModel: string) => string): void;
  /**
   * Complete every upstream `usage` object in place so strict clients always
   * receive `prompt_tokens`, `completion_tokens` and `total_tokens`. A field
   * the upstream omitted is emitted as `0`, and `total_tokens` is derived from
   * the present input/output when the upstream did not supply it. Non-usage
   * bodies are left untouched.
   */
  normalizeResponseUsage(payload: Record<string, unknown>): void;
  /** Protocol-fixed request fields, independent of any supplier. */
  prepareRequest(body: Record<string, unknown>): void;
  /**
   * The requested Fast state carried by this protocol's own official body
   * fields: `true` means on, `false` means explicitly off. Any unrelated
   * official value, or an absent field, yields `undefined` so the request is
   * forwarded unmodified.
   */
  readFast(body: Record<string, unknown>): boolean | undefined;
  /** Remove every raw reasoning spelling from a request body. */
  stripReasoningFields(body: Record<string, unknown>): void;
  createObserver(): ResponseObserver;
  /** One per-request translator of this protocol's generation events for TPS sampling. */
  createTpsTranslator(): TpsTranslator;
}

export const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

/**
 * Return a usage object that always carries `prompt_tokens`, `completion_tokens`
 * and `total_tokens`. A field the upstream omitted is filled with `0`; when the
 * upstream did not report `total_tokens` it is derived from the present
 * input/output. Every other field the upstream supplied (cached tokens,
 * reasoning details, …) is preserved.
 */
export function completeUsage(
  raw: Record<string, unknown>,
  input: number | undefined,
  output: number | undefined,
): Record<string, unknown> {
  const promptTokens = input ?? 0;
  const completionTokens = output ?? 0;
  const totalTokens = (count(raw.total_tokens) ?? 0) || (promptTokens + completionTokens);
  return {
    ...raw,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  };
}

/**
 * The `{type, code}` strings an official error object carries, if any. Only
 * optional fields are read, so an official frame missing them still counts as
 * the error it is; the caller supplies the empty object for that case.
 */
export function errorIdentityOf(source: unknown): { type?: string; code?: string } | undefined {
  const row = object(source);
  if (!row) return undefined;
  const identity = {
    ...(typeof row.type === 'string' ? { type: row.type } : {}),
    ...(typeof row.code === 'string' ? { code: row.code } : {}),
  };
  return Object.keys(identity).length > 0 ? identity : undefined;
}

/**
 * One public model as it appears in every entry protocol's `/models` body.
 *
 * A faulted route is never hidden: it is listed with its own `route_state` and
 * `route_until`. A half-open route (cooldown expired, awaiting a bounded
 * recovery probe) is reported with `route_phase: "half_open"` distinct from a
 * healthy route, so an expired cooldown is never read as recovery.
 */
export function modelListEntry(model: PublicGatewayModel): Record<string, unknown> {
  const phase = (model as { routePhase?: unknown }).routePhase;
  const nextProbeAt = (model as { routeNextProbeAt?: unknown }).routeNextProbeAt;
  const faultKind = (model as { faultKind?: unknown }).faultKind;
  return {
    // The model identity in every protocol listing is the bare registered id.
    // Provider selection is a separate dimension (the X-Wrenyard-Provider
    // request header); `publicId` is only the internal route key.
    id: model.id,
    object: 'model',
    owned_by: model.provider,
    display_name: model.displayName,
    context_window: model.contextWindow,
    max_tokens: model.maxTokens,
    route_state: model.routeState,
    route_until: model.routeUntil,
    ...(typeof phase === 'string' ? { route_phase: phase } : {}),
    ...(typeof nextProbeAt === 'string' ? { route_next_probe: nextProbeAt } : {}),
    ...(typeof faultKind === 'string' ? { fault_kind: faultKind } : {}),
  };
}

/**
 * The raw reasoning spellings the Gateway owns: they are stripped from a
 * request body before the owning provider's exact protocol fields are merged,
 * so a client that sends a speculatively-correct spelling can never conflict
 * with the resolved effort.
 */
export function stripReasoningFields(body: Record<string, unknown>): void {
  delete body.reasoning_effort;
  delete body.reasoning;
  delete body.thinking;
  delete body.enable_thinking;
  const outputConfig = object(body.output_config);
  if (!outputConfig) return;
  const next = { ...outputConfig };
  delete next.effort;
  if (Object.keys(next).length === 0) delete body.output_config;
  else body.output_config = next;
}

/**
 * Merge the owning provider's exact protocol fields into a stripped request
 * body. A provider-supplied `output_config` is merged over any remaining
 * caller `output_config` fields rather than replacing them.
 */
export function applyReasoningFields(body: Record<string, unknown>, fields: Record<string, unknown>): void {
  if (fields.output_config !== null && typeof fields.output_config === 'object' && !Array.isArray(fields.output_config)) {
    fields.output_config = { ...object(body.output_config), ...fields.output_config as Record<string, unknown> };
  }
  Object.assign(body, fields);
}
