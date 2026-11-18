/**
 * The definition-driven auxiliary runner a session host calls.
 *
 * The definitions themselves live in `./definitions.ts`; the loop, tool
 * builder and port vocabulary come from `@wrenyard/loop`.
 */

import {
  bindCatalog,
  buildAuxiliaryUser,
  protocolTools,
  runAuxiliaryLoop,
  toActionOutcome,
  type ActionExecutionOutcome,
  type ActionRunContext,
  type CallsPort,
  type LoopDeps,
  type LoopHelpers,
  type LoopRecord,
  type MethodCatalogPort,
} from '@wrenyard/loop';
import type { AuxiliaryRunRecordInput } from '@wrenyard/protocol';
import { getAuxiliaryDefinition, type AuxiliaryDefinitionId } from './definitions.ts';

export interface AuxiliaryRecordPort extends LoopRecord {
  helpers: LoopHelpers;
}

export interface AuxiliaryRunnerPorts {
  catalog: MethodCatalogPort;
  calls: CallsPort;
  record: AuxiliaryRecordPort;
  context: ActionRunContext;
  documentRules?: () => string;
  recordAuxiliaryRun?: (input: AuxiliaryRunRecordInput) => void;
}

/**
 * Run one auxiliary definition end to end.
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
