import {
  getAuxiliaryDefinition,
  type AuxiliaryDefinitionId,
  type DefinitionPorts,
  type LoopHelpers,
  type LoopRecord,
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

export const OBSERVATION_TOTAL_CHAR_CAP = 32_768;
export const OBSERVATION_TRUNCATED_NOTE =
  '[observation truncated: total observation size cap reached]';
export const OBSERVATION_OMITTED_NOTE =
  '[further observations omitted: total observation size cap reached]';

/** Read-only project/vcs results reach the caller through the run record, with a total size cap. */
export function observeSuccessfulToolResult(record: LoopRecord, content: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return;
  }
  if (parsed === null || typeof parsed !== 'object') return;
  if (!Array.isArray(parsed)) {
    const value = parsed as { error?: unknown };
    if (value.error !== undefined) return;
  }
  const used = record.observations.reduce((total, entry) => total + entry.length, 0);
  const remaining = OBSERVATION_TOTAL_CHAR_CAP - used;
  if (remaining <= 0) {
    if (record.observations[record.observations.length - 1] !== OBSERVATION_OMITTED_NOTE) {
      record.observations.push(OBSERVATION_OMITTED_NOTE);
    }
    return;
  }
  if (content.length <= remaining) {
    record.observations.push(content);
    return;
  }
  record.observations.push(`${content.slice(0, remaining)}\n${OBSERVATION_TRUNCATED_NOTE}`);
}

export function renderRunFiles(files: readonly { path: string; bytes: number }[]): string {
  if (files.length === 0) return 'The task directory has no files';
  return ['Files in the task directory:', ...files.map((file) => `- ${file.path} (${file.bytes} bytes)`)].join('\n');
}

export function fail(reason: string): ActionExecutionOutcome {
  return { status: 'failed', result: reason, deferred: [] };
}
