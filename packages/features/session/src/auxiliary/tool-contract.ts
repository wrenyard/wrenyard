/**
 * Verified tool-call contracts: a small module-level store of the tool name,
 * arguments, execution environment and success evidence of a tool call that
 * actually worked, plus the evidence-backed diagnosis of a tool observation.
 *
 * A missing tool, a call rejected for a wrong name or parameters, and a
 * function absent from the enumeration are three separate diagnoses; none of
 * them is reported as a missing MCP server unless a call was attempted and its
 * own result says so. Nothing here is a ledger event type; the store lives for
 * the process and is keyed by the same target identity as the dispatch gate.
 */
import { escapeBody } from '../context/render.ts';

function targetKeyOf(target: { project: string; task: string; worktree?: string }): string {
  return `${target.project}::${target.task}::${target.worktree ?? ''}`;
}

/** The target identity one verified contract was recorded for. */
export interface ToolContractRecord {
  target: { project: string; task: string; worktree?: string };
  tool: string;
  arguments: unknown;
  environment: string;
  evidence: string;
  at: string;
}

/** One observed tool interaction to diagnose. */
export type ToolCallObservation =
  | { kind: 'enumeration'; tools: readonly string[]; wanted: string }
  | { kind: 'call'; tool: string; arguments: unknown; environment?: string; result: string }
  | { kind: 'handshake'; enumerated: readonly string[]; called: string; environment?: string };

/** An evidence-backed diagnosis of a tool observation. */
export type ToolDiagnosis = {
  code: 'tool-missing' | 'tool-call-rejected' | 'function-not-enumerated' | 'no-mcp';
  tool: string;
  evidence: string;
  message: string;
};

const TOOL_NOT_FOUND = /tool not found/i;
const NO_MCP = /no mcp/i;

function firstLine(text: string): string {
  return text.split('\n', 1)[0] ?? '';
}

function quotedList(tools: readonly string[]): string {
  return `[${tools.join(', ')}]`;
}

/**
 * Diagnose one tool observation. `no-mcp` is returned only for a call whose own
 * result reports no MCP server; the other three codes never claim that. Each
 * message cites the observation's own evidence inline.
 */
export function diagnoseToolObservation(observation: ToolCallObservation): ToolDiagnosis {
  switch (observation.kind) {
    case 'enumeration': {
      const evidence = `enumerated tools: ${quotedList(observation.tools)}`;
      if (!observation.tools.includes(observation.wanted)) {
        return {
          code: 'tool-missing',
          tool: observation.wanted,
          evidence,
          message: `Tool '${observation.wanted}' was never enumerated, so it is missing from this environment (${evidence}).`,
        };
      }
      return {
        code: 'tool-call-rejected',
        tool: observation.wanted,
        evidence,
        message: `Tool '${observation.wanted}' is present in the enumeration (${evidence}), so a later failure is in how the call was made, not in tool availability.`,
      };
    }
    case 'call': {
      const evidence = `tool '${observation.tool}' called with ${JSON.stringify(observation.arguments)} returned: ${firstLine(observation.result)}`;
      if (TOOL_NOT_FOUND.test(observation.result)) {
        return {
          code: 'tool-call-rejected',
          tool: observation.tool,
          evidence,
          message: `The call was rejected because the tool name or parameters are wrong (${evidence}).`,
        };
      }
      if (NO_MCP.test(observation.result)) {
        return {
          code: 'no-mcp',
          tool: observation.tool,
          evidence,
          message: `The call reached no MCP server: the result itself reports no MCP is available (${evidence}).`,
        };
      }
      return {
        code: 'tool-call-rejected',
        tool: observation.tool,
        evidence,
        message: `The tool call did not succeed (${evidence}).`,
      };
    }
    case 'handshake': {
      const evidence = `enumerated tools: ${quotedList(observation.enumerated)}; called function: ${observation.called}`;
      if (!observation.enumerated.includes(observation.called)) {
        return {
          code: 'function-not-enumerated',
          tool: observation.called,
          evidence,
          message: `The handshake succeeded but '${observation.called}' is absent from the enumeration (${evidence}); this is an enumeration-scope question, not a stale binary.`,
        };
      }
      return {
        code: 'tool-call-rejected',
        tool: observation.called,
        evidence,
        message: `'${observation.called}' is present in the enumeration (${evidence}), so a later failure is in the call, not the enumeration.`,
      };
    }
  }
}

const contracts = new Map<string, ToolContractRecord[]>();

/** Store one verified contract, replacing an earlier record for the same tool. */
export function storeToolContract(record: ToolContractRecord): void {
  const key = targetKeyOf(record.target);
  const existing = contracts.get(key);
  if (existing === undefined) {
    contracts.set(key, [record]);
    return;
  }
  const index = existing.findIndex((candidate) => candidate.tool === record.tool);
  if (index === -1) existing.push(record);
  else existing[index] = record;
}

/**
 * The verified contracts recorded for one target, in insertion order. A record
 * matches when it has the same project, the same worktree (`''` when absent),
 * the same task or an empty-string project-wide task, and, when an environment
 * is supplied, exactly that environment: a contract is never reused on a device
 * where it was not verified.
 */
export function toolContractsFor(
  target: { project: string; task: string; worktree?: string },
  environment?: string,
): ToolContractRecord[] {
  const matched: ToolContractRecord[] = [];
  for (const records of contracts.values()) {
    for (const record of records) {
      if (record.target.project !== target.project) continue;
      if (record.target.task !== target.task && record.target.task !== '') continue;
      if ((record.target.worktree ?? '') !== (target.worktree ?? '')) continue;
      if (environment !== undefined && record.environment !== environment) continue;
      matched.push(record);
    }
  }
  return matched;
}

/** The single write API: record one verified, successful tool call. */
export function recordSuccessfulToolCall(record: ToolContractRecord): void {
  storeToolContract(record);
}

const CONTRACT_HEADER = 'Reuse these verified tool calls (tool, arguments, environment, success evidence) before claiming a tool is missing:';

/** Render verified contracts as one reuse block; empty input renders ''. */
export function renderToolContracts(records: readonly ToolContractRecord[]): string {
  if (records.length === 0) return '';
  const lines = records.map((record) => {
    const args = JSON.stringify(record.arguments) ?? 'undefined';
    return `- tool ${escapeBody(record.tool)} arguments ${escapeBody(args)} environment ${escapeBody(record.environment)} verified by ${escapeBody(record.evidence)}`;
  });
  return ['<verified-tool-contracts>', CONTRACT_HEADER, ...lines, '</verified-tool-contracts>'].join('\n');
}
