import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

/**
 * Focused integration regression for the Wrenyard DSH tool boundary.
 *
 * DSH tool guards are synchronous: `ToolGuard` returns `string | undefined`
 * directly. An `async` guard hands DSH a Promise, which DSH's `guardReason`
 * reads as a truthy denial (`reason !== undefined`) for EVERY tool, and whose
 * Promise value then fails lossless JSON materialization
 * (`tool result must be losslessly JSON-serializable`). The boundary plugin at
 * `packages/dsh-shell/src/tool-boundary.mjs` therefore must install a
 * synchronous guard.
 *
 * This test drives the REAL installed `@deepseek-ai/dsh-tools` ToolRuntime with
 * the REAL boundary plugin so the regression is caught end to end, not just at
 * the callback shape level.
 */

const sessionRootRequire = createRequire(import.meta.url);

/**
 * Resolve a DSH package out of the installed session dependency tree without
 * hardcoding a pnpm virtual-store hash. `@deepseek-ai/dsh-tools` is not a
 * direct dependency of this package; it is available in the session DSH
 * dependency graph, so anchoring on the resolved dsh manifest is the stable
 * route. The anchor is the manifest's *realpath*: pnpm's virtual store keeps
 * peer/dependency symlinks beside it, which the flat workspace `node_modules`
 * tree does not expose for transitive packages.
 */
function resolveDshPackage(specifier: string): string {
  const dshManifest = realpathSync(sessionRootRequire.resolve('@deepseek-ai/dsh/package.json'));
  return createRequire(dshManifest).resolve(specifier);
}

async function loadDsh<T>(specifier: string): Promise<T> {
  return (await import(pathToFileURL(resolveDshPackage(specifier)).href)) as T;
}

interface ToolRuntimeLike {
  register(definition: unknown): () => void;
  schemas(scope?: unknown): { name: string }[];
  execute(exec: {
    callId: string;
    name: string;
    arguments: unknown;
    signal: AbortSignal;
    agent?: unknown;
  }): Promise<{ isError?: boolean; error?: { message?: string }; content?: unknown }>;
}

type DefineTool = (options: {
  name: string;
  description: string;
  parameters: unknown;
  output: {
    schema: unknown;
    render: (args: unknown, value: unknown) => unknown;
  };
  execute: (args: unknown, exec: unknown) => Promise<unknown>;
}) => unknown;

const DENY_REASON = 'denied by the Wrenyard agent boundary';

/** A legitimate, non-orchestration tool that must keep working. */
const LEGITIMATE_TOOL = 'read_probe';

/** An orchestration tool registered AFTER the boundary snapshots the catalog. */
const LATE_ORCHESTRATION_TOOL = 'subagent';

test('boundary guard lets a legitimate tool run and denies a late-registered orchestration tool', async () => {
  const { ToolRuntime, defineTool } = await loadDsh<{
    ToolRuntime: new (ctx: unknown, config?: unknown) => ToolRuntimeLike;
    defineTool: DefineTool;
  }>('@deepseek-ai/dsh-tools');
  const { Context } = await loadDsh<{ Context: new () => unknown }>('@deepseek-ai/cordis');
  const { SystemPrompt } = await loadDsh<{ SystemPrompt: new (ctx: unknown, config?: unknown) => unknown }>(
    '@deepseek-ai/dsh-system-prompt',
  );
  const { createScope } = await loadDsh<{
    createScope: (ctx: unknown, key: symbol) => { ctx: unknown };
  }>('@deepseek-ai/dsh-scope');

  const boundaryModule = (await import(
    new URL('../../../../packages/dsh-shell/src/tool-boundary.mjs', import.meta.url).href
  )) as {
    name: string;
    ORCHESTRATION_DENY: readonly string[];
    apply(ctx: unknown): Promise<void>;
  };

  const root = new Context();
  // ToolRuntime injects `systemPrompt`; provide the real service so the runtime
  // constructs against its real dependency contract.
  new SystemPrompt(root, {});
  const tools = new ToolRuntime(root);

  let legitimateBodyCalls = 0;
  let orchestrationBodyCalls = 0;
  const defineProbe = (name: string): unknown =>
    defineTool({
      name,
      description: `probe ${name}`,
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute() {
        if (name === LATE_ORCHESTRATION_TOOL) orchestrationBodyCalls += 1;
        else legitimateBodyCalls += 1;
        return { ok: true, name };
      },
    });

  tools.register(defineProbe(LEGITIMATE_TOOL));
  assert.ok(
    boundaryModule.ORCHESTRATION_DENY.includes(LATE_ORCHESTRATION_TOOL),
    'the orchestration tool under test must be on the declared deny list',
  );

  // The boundary is agent-scoped: register it through a scoped context, so
  // `tools.restrict()` (which refuses a context-global restriction) is legal.
  const scopeKey = Symbol('dsh-tool-boundary-test-scope');
  const { ctx: scopedCtx } = createScope(root, scopeKey);
  await boundaryModule.apply(scopedCtx);

  // Register the orchestration tool only AFTER the boundary took its snapshot.
  // The monotonic guard — not the schema snapshot — is what must deny it.
  tools.register(defineProbe(LATE_ORCHESTRATION_TOOL));

  const signal = new AbortController().signal;
  const agent = scopeKey;

  const legitimate = await tools.execute({
    callId: 'boundary-legit',
    name: LEGITIMATE_TOOL,
    arguments: {},
    signal,
    agent,
  });

  assert.notEqual(
    legitimate.isError,
    true,
    `a legitimate tool must still execute (got ${JSON.stringify(legitimate.error ?? legitimate)})`,
  );
  assert.equal(legitimateBodyCalls, 1, 'the legitimate tool body must have run exactly once');
  assert.doesNotMatch(
    JSON.stringify(legitimate),
    /losslessly JSON-serializable/,
    'a synchronous guard must never surface the Promise-serialization failure',
  );

  const orchestration = await tools.execute({
    callId: 'boundary-orch',
    name: LATE_ORCHESTRATION_TOOL,
    arguments: {},
    signal,
    agent,
  });

  assert.equal(orchestration.isError, true, 'the late-registered orchestration tool must be denied');
  assert.equal(
    orchestration.error?.message,
    DENY_REASON,
    'the denial must carry the boundary plugin reason verbatim',
  );
  assert.equal(
    orchestrationBodyCalls,
    0,
    'a denied orchestration tool must never have its body invoked',
  );
  assert.doesNotMatch(
    JSON.stringify(orchestration),
    /losslessly JSON-serializable/,
    'the denial must be materialized as a normal result, not a serialization failure',
  );
});
