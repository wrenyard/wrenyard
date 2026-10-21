import {
  getAuxiliaryDefinition,
  type AuxiliaryDefinitionId,
  type DefinitionPorts,
  type LoopHelpers,
} from '@wrenyard/agent-loop';

import { escapeBody, renderEventsBlock, renderEventText } from '../context/render.ts';
import { messageOf } from '../errors.ts';
import type { LedgerEvent } from '../ledger/store.ts';
import { boundedOutputReservation, resolveModelMetadata } from '../model/metadata.ts';
import { estimateTokens } from '../model/request.ts';
import type { AuxiliaryCallRole } from '../model/roles.ts';
import type { SessionHost } from '../ports.ts';
import type { ActionExecutionOutcome } from '../reasoning/actions.ts';

/** Reserve for multi-round tool results inside one auxiliary loop. */
export const AUXILIARY_MULTI_ROUND_TOOL_RESULT_RESERVE = 12_288;

type AuxiliaryHost = Pick<SessionHost, 'selectAuxiliary' | 'resolveInferenceProvider'>;

function baseAuxiliaryLoopHelpers(): LoopHelpers {
  return {
    messageOf,
    escapeBody,
    renderEventsBlock: (events) => renderEventsBlock(events as readonly LedgerEvent[]),
  };
}

function outputReservation(
  maxOutputTokens: number | undefined,
  requestedMaxOutputTokens?: number,
): number {
  const sourceMax = boundedOutputReservation(maxOutputTokens) ?? 0;
  if (requestedMaxOutputTokens === undefined) return sourceMax;
  return sourceMax === 0 ? requestedMaxOutputTokens : Math.min(requestedMaxOutputTokens, sourceMax);
}

/**
 * Conservative conversation budget from one route's metadata, system prompt
 * size and output reservation.
 */
export function auxiliaryConversationBudgetFromMetadata(
  contextWindow: number | undefined,
  maxOutputTokens: number | undefined,
  systemPromptTokens: number,
  requestedMaxOutputTokens?: number,
): number | undefined {
  if (contextWindow === undefined) return undefined;
  const reserved = outputReservation(maxOutputTokens, requestedMaxOutputTokens);
  const budget = contextWindow - reserved - systemPromptTokens - AUXILIARY_MULTI_ROUND_TOOL_RESULT_RESERVE;
  return budget > 0 ? budget : undefined;
}

/** Minimum conversation budget across every auxiliary route for one role. */
export async function computeAuxiliaryConversationTokenBudget(
  host: AuxiliaryHost,
  role: AuxiliaryCallRole,
  systemPromptTokens: number,
  requestedMaxOutputTokens?: number,
): Promise<number | undefined> {
  let routes;
  try {
    routes = await host.selectAuxiliary(role);
  } catch {
    return undefined;
  }
  if (routes.length === 0) return undefined;
  let minBudget: number | undefined;
  for (const route of routes) {
    const metadata = resolveModelMetadata(route.model, (id) => host.resolveInferenceProvider(id));
    if (metadata.contextWindow === undefined) continue;
    const budget = auxiliaryConversationBudgetFromMetadata(
      metadata.contextWindow,
      metadata.maxOutputTokens,
      systemPromptTokens,
      requestedMaxOutputTokens,
    );
    if (budget === undefined) continue;
    minBudget = minBudget === undefined ? budget : Math.min(minBudget, budget);
  }
  return minBudget;
}

/** Shared route-aware helpers for document, todo, vcs and project auxiliaries. */
export async function createAuxiliaryLoopHelpers(
  host: AuxiliaryHost,
  definitionId: AuxiliaryDefinitionId,
  documentRules: DefinitionPorts['documentRules'] = () => '',
): Promise<LoopHelpers> {
  const base = baseAuxiliaryLoopHelpers();
  const definition = getAuxiliaryDefinition(definitionId);
  if (definition === undefined) return base;
  const systemPromptTokens = estimateTokens(definition.buildSystemPrompt({ documentRules }));
  const conversationTokenBudget = await computeAuxiliaryConversationTokenBudget(
    host,
    definition.role,
    systemPromptTokens,
  );
  if (conversationTokenBudget === undefined) return base;
  return {
    ...base,
    estimateTokens,
    conversationTokenBudget,
    renderEvent: (event) => renderEventText(event as LedgerEvent),
  };
}

/** Conversation budget for the reply auxiliary role. */
export async function computeReplyConversationTokenBudget(
  host: AuxiliaryHost,
  replySystemPromptTokens: number,
  requestedMaxOutputTokens: number,
): Promise<number | undefined> {
  return computeAuxiliaryConversationTokenBudget(
    host,
    'reply',
    replySystemPromptTokens,
    requestedMaxOutputTokens,
  );
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function renderRunFiles(files: readonly { path: string; bytes: number }[]): string {
  if (files.length === 0) return 'The task directory has no files';
  return ['Files in the task directory:', ...files.map((file) => `- ${file.path} (${file.bytes} bytes)`)].join('\n');
}

export function fail(reason: string): ActionExecutionOutcome {
  return { status: 'failed', result: reason, deferred: [] };
}

/** At most this many attempts of one auxiliary call, failed calls and rejected outputs together. */
export const AUXILIARY_ATTEMPTS = 3;

/**
 * The shared light retry of one auxiliary call: up to AUXILIARY_ATTEMPTS
 * immediate attempts with no backoff, each handed the previous failure so it
 * can tell the model what went wrong. A route that failed is already recorded
 * in route state, so the next attempt's selection moves on by itself.
 */
export async function withAuxiliaryRetry<T, F extends { error: string }>(
  attempt: (previous: F | undefined) => Promise<{ ok: true; value: T } | ({ ok: false } & F)>,
  signal?: AbortSignal,
): Promise<{ ok: true; value: T } | ({ ok: false } & F) | { ok: false; error: string }> {
  let previous: ({ ok: false } & F) | undefined;
  for (let n = 0; n < AUXILIARY_ATTEMPTS && signal?.aborted !== true; n += 1) {
    const result = await attempt(previous);
    if (result.ok) return result;
    previous = result;
  }
  return previous ?? { ok: false, error: 'aborted before the first attempt' };
}
