/**
 * The definition-driven auxiliary runner a session host calls.
 *
 * The definitions themselves live in `./definitions.ts`; the loop, tool
 * builder and port vocabulary come from `@wrenyard/loop`.
 */

import { getAuxiliaryDefinition, type AuxiliaryDefinitionId } from './definitions.ts';
import {
  bindCatalog,
  buildAuxiliaryUser,
  protocolTools,
  runAuxiliaryLoop,
  toActionOutcome,
  type LoopDeps,
  type LoopRecord,
} from '@wrenyard/loop';
import type { AuxiliaryRunRecordInput } from '@wrenyard/protocol';
import type {
  ActionExecutionOutcome,
  ActionRunContext,
  CallsPort,
  LoopHelpers,
  MethodCatalogPort,
} from '@wrenyard/loop';

/**
 * The record a host supplies to {@link runAuxiliary}: the loop's mutable
 * record plus the host's own text/diagnostic helpers and optional hooks.
 */
export interface AuxiliaryRecordPort extends LoopRecord {
  /** The host helpers the loop reuses instead of importing host modules. */
  helpers: LoopHelpers;
}

/** Everything one definition-driven auxiliary run needs from its host. */
export interface AuxiliaryRunnerPorts {
  /** The host's protocol-method catalog, gated by the running definition. */
  catalog: MethodCatalogPort;
  /** The host's model transport and span bookkeeping. */
  calls: CallsPort;
  /** The host's record adapter and helpers. */
  record: AuxiliaryRecordPort;
  /** The action context the auxiliary runs inside. */
  context: ActionRunContext;
  /** The workspace document rules, used by the document definition only. */
  documentRules?: () => string;
  /**
   * Optional hook recording one finished auxiliary run into the unified run
   * record. Threaded into the loop; absent hosts simply skip the record.
   */
  recordAuxiliaryRun?: (input: AuxiliaryRunRecordInput) => void;
}

/**
 * Run one auxiliary definition end to end. The definition supplies the
 * system prompt, the method allowlist, the effect map and the round budget;
 * the host supplies the catalog, the model transport, the record and the
 * action context.
 */
export async function runAuxiliary(
  definitionId: AuxiliaryDefinitionId,
  intent: string,
  ports: AuxiliaryRunnerPorts,
): Promise<ActionExecutionOutcome> {
  const definition = getAuxiliaryDefinition(definitionId);
  if (definition === undefined) {
    throw new Error(`Unknown auxiliary definition: ${definitionId}`);
  }
  const { context, record } = ports;
  const helpers = record.helpers;
  const deps: LoopDeps = {
    host: bindCatalog(ports.catalog, definition.role),
    calls: ports.calls,
    helpers,
    ...(ports.recordAuxiliaryRun === undefined ? {} : { recordAuxiliaryRun: ports.recordAuxiliaryRun }),
  };
  const tools = await protocolTools(
    deps.host,
    helpers,
    context,
    record,
    definition.methods,
    definition.effects,
  );
  const result = await runAuxiliaryLoop({
    deps,
    ctx: context,
    role: definition.role,
    system: definition.buildSystemPrompt({ documentRules: ports.documentRules ?? (() => '') }),
    user: buildAuxiliaryUser(context, intent, helpers),
    tools,
    maxRounds: definition.maxRounds,
    spanIdPrefix: definition.spanIdPrefix,
    record,
  });
  return toActionOutcome(result, record);
}
