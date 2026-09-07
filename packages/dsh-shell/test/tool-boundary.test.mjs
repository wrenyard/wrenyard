import { test } from 'node:test';
import assert from 'node:assert/strict';

import plugin, { ORCHESTRATION_DENY } from '../src/tool-boundary.mjs';

const WRENYARD_ALIASES = [
  'list_task',
  'describe_task',
  'run_task',
  'list_workspace_docs',
  'read_workspace_doc',
  'create_workspace_doc',
  'update_workspace_doc',
];

const LEGITIMATE_NATIVE = [
  'bash',
  'read',
  'write',
  'edit',
  'grep',
  'web_search',
  'ask_user_question',
  'job_list',
  'create_goal',
];

function catalogFor(names) {
  return names.map((name) => ({ name, schema: { type: 'object', description: `tool ${name}` } }));
}

function makeCtx(tools) {
  return { tools };
}

function toolsWith(catalog, { withSchemas = true, withRestrict = true, withGuard = true } = {}) {
  const restrictCalls = [];
  const guardHandlers = [];
  const tools = { restrictCalls, guardHandlers };
  if (withSchemas) tools.schemas = () => catalog;
  if (withRestrict) tools.restrict = (options) => restrictCalls.push(options);
  if (withGuard) tools.guard = (handler) => {
    guardHandlers.push(handler);
    return () => {};
  };
  return tools;
}

test('deny set is the exact competing-orchestration list and never names run_code', () => {
  assert.deepEqual(ORCHESTRATION_DENY, [
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
  assert.ok(!ORCHESTRATION_DENY.includes('run_code'), 'run_code must never appear in the deny set');
});

test('full catalog restricts exactly the present competing names once, leaving legitimate tools visible', async () => {
  const fullCatalog = catalogFor([...LEGITIMATE_NATIVE, ...WRENYARD_ALIASES, ...ORCHESTRATION_DENY]);
  const tools = toolsWith(fullCatalog);

  await plugin.apply(makeCtx(tools));

  assert.equal(tools.restrictCalls.length, 1, 'restrict is called exactly once');
  assert.deepEqual(tools.restrictCalls[0], { deny: ORCHESTRATION_DENY });

  const denied = new Set(tools.restrictCalls[0].deny);
  for (const legit of [...LEGITIMATE_NATIVE, ...WRENYARD_ALIASES]) {
    assert.ok(!denied.has(legit), `legitimate tool ${legit} must stay visible`);
  }
  assert.ok(!denied.has('run_code'), 'the deny argument must never name run_code');
});

test('platform/catalog subsets restrict only the competing names that are present', async () => {
  // Catalog subset with a few competing tools (e.g. Unix-style platform catalog).
  const subset = catalogFor([...LEGITIMATE_NATIVE, ...WRENYARD_ALIASES, 'subagent', 'workflow', 'send_message']);
  const t1 = toolsWith(subset);
  await plugin.apply(makeCtx(t1));
  assert.deepEqual(t1.restrictCalls, [{ deny: ['subagent', 'send_message', 'workflow'] }]);

  // A catalog holding every competing tool across platforms still restricts once with the full set.
  const everyone = toolsWith(catalogFor([...ORCHESTRATION_DENY, 'bash']));
  await plugin.apply(makeCtx(everyone));
  assert.deepEqual(everyone.restrictCalls, [{ deny: ORCHESTRATION_DENY }]);

  // No competing tools present -> no restrict call at all.
  const clean = toolsWith(catalogFor([...LEGITIMATE_NATIVE, ...WRENYARD_ALIASES]));
  await plugin.apply(makeCtx(clean));
  assert.equal(clean.restrictCalls.length, 0, 'no restriction needed when no competing tool is present');

  // Empty catalog -> no restrict call.
  const empty = toolsWith(catalogFor([]));
  await plugin.apply(makeCtx(empty));
  assert.equal(empty.restrictCalls.length, 0);
});

test('missing schemas()/restrict()/guard() fails loudly instead of silently weakening the boundary', async () => {
  await assert.rejects(
    () => plugin.apply(makeCtx({ restrict() {} })),
    /tools\.schemas\(\)/,
  );
  await assert.rejects(
    () => plugin.apply(makeCtx({ schemas: () => catalogFor(ORCHESTRATION_DENY) })),
    /tools\.restrict\(\)/,
  );
  await assert.rejects(
    () => plugin.apply(makeCtx({ schemas: () => catalogFor([]), restrict() {} })),
    /tools\.guard\(\)/,
  );
});

test('installs one monotonic guard denying every competing orchestration name, including later registrations absent from schemas', async () => {
  // Visible catalog is clean, so no restrict() is needed; the guard is still
  // installed and must stop any competing orchestration tool registered later
  // (after the schemas() snapshot) that was therefore never hidden.
  const tools = toolsWith(catalogFor([...LEGITIMATE_NATIVE, ...WRENYARD_ALIASES]));
  await plugin.apply(makeCtx(tools));

  assert.equal(tools.restrictCalls.length, 0, 'nothing to restrict in the visible catalog');
  assert.equal(tools.guardHandlers.length, 1, 'exactly one agent-scoped guard is installed');
  const guard = tools.guardHandlers[0];

  for (const name of ORCHESTRATION_DENY) {
    assert.equal(
      await guard({ name, input: {} }),
      'denied by the Wrenyard agent boundary',
      `${name} is denied by the guard with the fixed concise reason`,
    );
  }

  for (const legit of [...LEGITIMATE_NATIVE, ...WRENYARD_ALIASES, 'run_code']) {
    const decision = await guard({ name: legit, input: {} });
    assert.equal(decision, undefined, `${legit} is not matched by the guard`);
  }
});
