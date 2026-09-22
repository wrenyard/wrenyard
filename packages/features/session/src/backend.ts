import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WrenyardGatewayConnection } from '@wrenyard/control-client';
import type { ConversationSnapshot, WorkspaceConfigurationSnapshot } from '@wrenyard/protocol/session';
import { DshConversationClient, type ConversationSummaryInput } from './dsh-conversation-client.js';
import { startDshWeb } from './dsh-process.js';
import { defaultMcpUrl, WRENYARD_DSH_PROVIDER_ID, WRENYARD_GATEWAY_TOKEN_ENV, writeModelPatch } from './model-patch.js';
import { resolveDshBin, resolveRuntimeModulesDir, resolveShellSource } from './paths.js';
import { prepareProfile } from './profile.js';
import { conversationStatePath, dshHomePath } from './state-root.js';
import { ensureProductWorkspaceRegistered } from './workspace-registry.js';

/** A configured workspace with its canonical directory guaranteed present. */
export type ConfiguredWorkspace = WorkspaceConfigurationSnapshot & {
  status: 'configured';
  path: string;
};

/**
 * One live DSH conversation backend for one workspace: the child process, the
 * product-owned conversation engine on top of it, and the durable document.
 */
export interface SessionBackend {
  /**
   * Live pid of the backing DSH child process while this backend is active.
   * Main-process diagnostics only; never exposed to the renderer.
   */
  readonly backendProcessId?: number;
  snapshot(): ConversationSnapshot;
  select(sessionId: string): Promise<ConversationSnapshot>;
  create(): Promise<ConversationSnapshot>;
  selectModel(provider: string, model: string, reasoningEffort?: string): Promise<ConversationSnapshot>;
  send(text: string, clientTimeZone?: string): Promise<ConversationSnapshot>;
  cancel(turnId?: string): Promise<ConversationSnapshot>;
  stop(): Promise<void>;
}

export interface StartedSessionBackend {
  backend: SessionBackend;
  /** Gateway connection the DSH model patch was generated from. */
  gateway: WrenyardGatewayConnection;
}

export interface StartSessionBackendOptions {
  stateRoot: string;
  workspace: ConfiguredWorkspace;
  ipcPath: string;
  getGatewayConnection: () => Promise<WrenyardGatewayConnection>;
  waitForTaskRun: (taskRunId: string, signal: AbortSignal) => Promise<unknown>;
  cancelTaskRun: (taskRunId: string) => Promise<void>;
  summarize: (input: ConversationSummaryInput) => Promise<string>;
  /** Published whenever the product projection may have changed. */
  onChanged: () => void;
  /** The DSH child exited on its own; the caller owns recovery. */
  onUnexpectedExit: (message: string) => void;
}

/**
 * Start the DSH backend for one workspace.
 *
 * The DSH profile is prepared from the managed `@wrenyard/dsh-shell` copy, the
 * workspace is registered in DSH's durable workspace registry, and the model
 * patch is regenerated from the live Gateway connection. A failure during start
 * always tears the child process down before propagating, so a failed start
 * never leaves a stray backend behind.
 */
export async function startSessionBackend(
  options: StartSessionBackendOptions,
): Promise<StartedSessionBackend> {
  const dshHome = dshHomePath(options.stateRoot);
  const profile = await prepareProfile(dshHome, resolveShellSource(), resolveRuntimeModulesDir());
  ensureChineseLocale(profile.dshHome);
  const registration = await ensureProductWorkspaceRegistered(profile.dshHome, options.workspace.path);
  const gateway = await options.getGatewayConnection();
  const patchPath = await writeModelPatch(profile.dshHome, gateway);
  const extraEnv: NodeJS.ProcessEnv = { [WRENYARD_GATEWAY_TOKEN_ENV]: gateway.token };
  const wrenyardEnv: NodeJS.ProcessEnv = {
    WRENYARD_IPC_PATH: options.ipcPath,
    WRENYARD_MCP_URL: defaultMcpUrl(),
  };
  const sender = process.env.WRENYARD_MCP_SENDER ?? process.env.FOREMAN_MCP_SENDER;
  if (sender) wrenyardEnv.WRENYARD_MCP_SENDER = sender;

  const dsh = await startDshWeb({
    binPath: resolveDshBin(),
    profileHome: profile.dshHome,
    workspace: options.workspace.path,
    wrenyardEnv,
    patchPath,
    extraEnv,
  });
  const client = new DshConversationClient({
    baseUrl: dsh.url,
    workspaceId: registration.id,
    workspace: options.workspace,
    configuredProviderIds: [WRENYARD_DSH_PROVIDER_ID],
    statePath: conversationStatePath(options.stateRoot, options.workspace.path),
    summarize: options.summarize,
    // Nonblocking dispatch: a work turn owns the runs it dispatched and learns
    // their authoritative outcome from the daemon itself, never from the model.
    waitForTaskRun: options.waitForTaskRun,
    cancelTaskRun: options.cancelTaskRun,
    onChanged: options.onChanged,
  });
  let intentionalStop = false;
  dsh.child.on('exit', (code, signal) => {
    if (intentionalStop) return;
    client.stop();
    options.onUnexpectedExit(`DSH 会话后端已停止（code ${code ?? 'unknown'}，signal ${signal ?? 'none'}）`);
  });
  try {
    await client.start();
  } catch (error) {
    intentionalStop = true;
    client.stop();
    await dsh.stop().catch(() => undefined);
    throw error;
  }

  return {
    gateway,
    backend: {
      backendProcessId: dsh.child.pid,
      snapshot: () => client.snapshot(),
      select: (sessionId) => client.select(sessionId),
      create: () => client.create(),
      selectModel: (provider, model, reasoningEffort) => client.selectModel(provider, model, reasoningEffort),
      send: (text, clientTimeZone) => client.send(text, clientTimeZone),
      // The addressed turn is carried through to the engine, so cancelling one
      // turn never touches a parallel turn of the same conversation.
      cancel: (turnId) => client.cancel(turnId),
      stop: async () => {
        intentionalStop = true;
        client.stop();
        await dsh.stop();
      },
    },
  };
}

/**
 * Pin the DSH profile locale to Chinese once, without ever overwriting an
 * explicit preference the user or another surface already wrote.
 */
function ensureChineseLocale(dshHome: string): void {
  const settingsPath = join(dshHome, 'settings.yaml');
  let existing = '';
  if (existsSync(settingsPath)) existing = readFileSync(settingsPath, 'utf8');
  if (/(?:^|\n)locale\s*:/.test(existing)) return;
  const prefix = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`;
  writeFileSync(settingsPath, `${prefix}locale:\n  preference: zh\n`);
}
