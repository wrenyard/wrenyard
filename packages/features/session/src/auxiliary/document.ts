/** Document auxiliaries use the host's durable workspace document commit path. */
import { runAuxiliary, createLoopRecord, type AuxiliaryRecordPort, type LoopRecord } from '@wrenyard/agent-loop';
import { createAuxiliaryLoopHelpers, OBSERVATION_TOTAL_CHAR_CAP, OBSERVATION_TRUNCATED_NOTE, OBSERVATION_OMITTED_NOTE } from './shared.ts';
import type { ActionExecutionOutcome, ActionRunContext, ActionRunnerDeps, ParsedAction } from '../reasoning/actions.ts';

export async function runDocumentAction(
  deps: ActionRunnerDeps,
  action: ParsedAction,
  ctx: ActionRunContext,
): Promise<ActionExecutionOutcome> {
  const record: AuxiliaryRecordPort = {
    ...createLoopRecord(),
    helpers: await createAuxiliaryLoopHelpers(deps.host, 'document', () => deps.files.readDocumentRules()),
  };
  // A successful read/list produces no workspace change or document draft, so
  // the actual returned payload is recorded as the authoritative observation
  // that reaches the parent conversation. Bounded to the shared cap.
  record.observeToolResult = (content) => observeDocumentResult(record, content);
  return runAuxiliary('document', action.intent, {
    catalog: deps.host, calls: deps.calls, record, context: ctx,
    documentRules: () => deps.files.readDocumentRules(),
  });
}

/**
 * Record a successful workspace.doc.read or list result as the run's
 * authoritative observation, so the real document content reaches the caller
 * instead of an "already in context" summary. Error results and other payloads
 * are ignored: writes already record their change through the effect map.
 */
function observeDocumentResult(record: LoopRecord, content: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  const value = parsed as { error?: unknown; content?: unknown; documents?: unknown };
  if (value.error !== undefined) return;
  if (typeof value.content !== 'string' && !Array.isArray(value.documents)) return;
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
