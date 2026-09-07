/**
 * @wrenyard/dsh-shell/tool-boundary
 *
 * Agent-scoped Wrenyard tool boundary for DeepSeek Harness (DSH).
 *
 * DSH's native tool presentation never exposes its unrestricted run_code tool,
 * so this plugin never names run_code. It only hides competing DSH
 * orchestration/subagent/workflow tools inside the Wrenyard agent scope.
 * Legitimate guarded native non-orchestration tools (bash, file I/O, editing,
 * search, browser, jobs, goals, skills, ask-user) are deliberately not listed
 * here and stay governed by the existing sandbox/approval policy.
 *
 * A monotonic execution guard additionally denies those orchestration names at
 * run time, so a competing tool registered after startup (absent from the
 * schemas() snapshot) still cannot execute inside the Wrenyard agent scope.
 */

export const name = 'wrenyard-tool-boundary';

export const inject = ['tools'];

export const ORCHESTRATION_DENY = Object.freeze([
  'subagent',
  'subagent_fork',
  'list_agents',
  'send_message',
  'interrupt_agent',
  'workflow',
  'ralph',
  'ralph-loop',
  'report',
]);

const ORCHESTRATION_DENY_SET = new Set(ORCHESTRATION_DENY);

function collectNames(raw) {
  const names = new Set();
  const list = Array.isArray(raw)
    ? raw
    : raw && Array.isArray(raw.tools)
      ? raw.tools
      : [];
  for (const entry of list) {
    if (typeof entry === 'string') {
      names.add(entry);
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry.name ?? entry.definition?.name ?? entry.schema?.name;
    if (typeof candidate === 'string') names.add(candidate);
  }
  return names;
}

export async function apply(ctx) {
  const { tools } = ctx;
  if (typeof tools.schemas !== 'function') {
    throw new Error('Wrenyard: tool boundary requires tools.schemas(); refusing to weaken the agent-scoped boundary');
  }
  if (typeof tools.restrict !== 'function') {
    throw new Error('Wrenyard: tool boundary requires tools.restrict(); refusing to weaken the agent-scoped boundary');
  }
  if (typeof tools.guard !== 'function') {
    throw new Error('Wrenyard: tool boundary requires tools.guard(); refusing to weaken the agent-scoped boundary');
  }
  const catalog = (await tools.schemas()) || [];
  const present = ORCHESTRATION_DENY.filter((candidate) => collectNames(catalog).has(candidate));
  if (present.length > 0) tools.restrict({ deny: present });

  // Monotonic agent-scoped guard: closes the later-registration/ordering gap by
  // denying execution of any ORCHESTRATION_DENY name, even one registered after
  // the schemas() snapshot above. Uses a fixed reason, never names run_code, and
  // returns no opinion for legitimate tools.
  tools.guard(async (exec) => {
    if (exec && typeof exec.name === 'string' && ORCHESTRATION_DENY_SET.has(exec.name)) {
      return 'denied by the Wrenyard agent boundary';
    }
    return undefined;
  });
}

export default { name, inject, apply };
