import { unavailableConversation } from './dsh-conversation-client.js';
import type {
  ConversationSnapshot,
  WorkspaceConfigurationSnapshot,
} from './shell-contract.js';

export type ConfiguredWorkspace = WorkspaceConfigurationSnapshot & {
  status: 'configured';
  path: string;
};

export interface DesktopConversationSession {
  snapshot(): ConversationSnapshot;
  select(sessionId: string): Promise<ConversationSnapshot>;
  create(): Promise<ConversationSnapshot>;
  selectModel(provider: string, model: string): Promise<ConversationSnapshot>;
  send(text: string, clientTimeZone?: string): Promise<ConversationSnapshot>;
  cancel(): Promise<ConversationSnapshot>;
  stop(): void | Promise<void>;
  /**
   * Live pid of the backing DSH child process while a session backend is active.
   * Internal smoke observability only; never exposed to renderer IPC.
   */
  backendProcessId?: number;
}

export interface DesktopConversationControllerOptions {
  initialWorkspace: WorkspaceConfigurationSnapshot;
  createSession(
    workspace: ConfiguredWorkspace,
    onUnexpectedExit: (message: string) => void,
  ): Promise<DesktopConversationSession>;
  onChanged(): void;
}

/**
 * Serializes DSH session-backend transitions while keeping the renderer and
 * Desktop process alive. Workspace changes replace only the backend session.
 */
export class DesktopConversationController {
  private workspaceValue: WorkspaceConfigurationSnapshot;
  private session: DesktopConversationSession | null = null;
  private error: string | undefined;
  private generation = 0;
  private transition: Promise<void> = Promise.resolve();
  /** Selected session id remembered before an unexpected exit or forced replacement. */
  private restoreSessionId: string | undefined;

  constructor(private readonly options: DesktopConversationControllerOptions) {
    this.workspaceValue = options.initialWorkspace;
  }

  get workspace(): WorkspaceConfigurationSnapshot {
    return this.workspaceValue;
  }

  /**
   * Live pid of the active session's DSH backend child; internal smoke
   * observability only (never exposed to renderer IPC). Clears naturally when
   * the session is replaced, stopped, or exits unexpectedly.
   */
  get backendProcessId(): number | undefined {
    return this.session?.backendProcessId;
  }

  start(): Promise<void> {
    return this.configure(this.workspaceValue);
  }

  configure(workspace: WorkspaceConfigurationSnapshot): Promise<void> {
    return this.enqueue(async () => {
      const generation = ++this.generation;
      const previous = this.session;
      this.session = null;
      this.workspaceValue = workspace;
      this.error = undefined;
      await previous?.stop();
      this.options.onChanged();

      if (workspace.status !== 'configured' || !workspace.path) return;
      const configured: ConfiguredWorkspace = {
        ...workspace,
        status: 'configured',
        path: workspace.path,
      };
      try {
        const session = await this.options.createSession(configured, (message) => {
          this.handleUnexpectedExit(generation, message);
        });
        if (generation !== this.generation) {
          await session.stop();
          return;
        }
        this.session = session;
        this.options.onChanged();
      } catch (error) {
        if (generation === this.generation) {
          this.error = error instanceof Error ? error.message : String(error);
          this.options.onChanged();
        }
        throw error;
      }
    });
  }

  stop(): Promise<void> {
    return this.enqueue(async () => {
      this.generation += 1;
      const session = this.session;
      this.session = null;
      await session?.stop();
    });
  }

  /**
   * Restore a live DSH session for the configured workspace when none is live,
   * or replace the ready session when force is true. A strict no-op when a
   * session is already live and force is false. Selected-session continuity is
   * best-effort: the id selected before the exit/replacement is re-selected
   * once on the replacement session before ready is published.
   */
  recover(force = false): Promise<void> {
    return this.enqueue(async () => {
      if (this.session && !force) return;

      const generation = ++this.generation;
      const previous = this.session;
      if (previous) this.restoreSessionId = previous.snapshot().selectedSessionId;
      this.session = null;
      this.error = undefined;
      await previous?.stop();
      this.options.onChanged();

      const workspace = this.workspaceValue;
      if (workspace.status !== 'configured' || !workspace.path) return;
      const configured: ConfiguredWorkspace = {
        ...workspace,
        status: 'configured',
        path: workspace.path,
      };
      try {
        const session = await this.options.createSession(configured, (message) => {
          this.handleUnexpectedExit(generation, message);
        });
        if (generation !== this.generation) {
          await session.stop();
          return;
        }
        this.session = session;
        const restore = this.restoreSessionId;
        this.restoreSessionId = undefined;
        if (restore !== undefined) {
          await session.select(restore);
        }
        this.options.onChanged();
      } catch (error) {
        if (generation === this.generation) {
          this.error = error instanceof Error ? error.message : String(error);
          this.options.onChanged();
        }
        throw error;
      }
    });
  }

  snapshot(): ConversationSnapshot {
    return this.session?.snapshot() ?? unavailableConversation(this.workspaceValue, this.error);
  }

  select(sessionId: string): Promise<ConversationSnapshot> {
    return this.requireSession().select(sessionId);
  }

  create(): Promise<ConversationSnapshot> {
    return this.requireSession().create();
  }

  selectModel(provider: string, model: string): Promise<ConversationSnapshot> {
    return this.requireSession().selectModel(provider, model);
  }

  send(text: string, clientTimeZone?: string): Promise<ConversationSnapshot> {
    return this.requireSession().send(text, clientTimeZone);
  }

  cancel(): Promise<ConversationSnapshot> {
    return this.requireSession().cancel();
  }

  private requireSession(): DesktopConversationSession {
    if (!this.session) throw new Error(this.error ?? '请先配置 Wrenyard workspace');
    return this.session;
  }

  private handleUnexpectedExit(generation: number, message: string): void {
    if (generation !== this.generation) return;
    const session = this.session;
    if (session) this.restoreSessionId = session.snapshot().selectedSessionId;
    this.session = null;
    this.error = message;
    void Promise.resolve(session?.stop()).catch(() => undefined);
    this.options.onChanged();
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.transition.catch(() => undefined).then(operation);
    this.transition = result.catch(() => undefined);
    return result;
  }
}
