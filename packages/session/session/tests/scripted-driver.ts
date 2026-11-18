import type {
  SessionDriverContext,
  SessionDriverPort,
  SessionEventBase,
  SubSessionSpec,
  TailRepairPlan,
} from '../src/index.ts';

export interface ScriptedTurnCall<E extends SessionEventBase, TTurnInput> {
  sessionId: string;
  turn: number;
  input: TTurnInput;
  signal: AbortSignal;
  ctx: SessionDriverContext<E, TTurnInput>;
}

export class ScriptedDriver<
  E extends SessionEventBase = SessionEventBase,
  TTurnInput = unknown,
  TResult = void,
> implements SessionDriverPort<E, TTurnInput, TResult> {
  readonly recovered: Array<{ sessionId: string; events: readonly E[]; repair: TailRepairPlan }> = [];
  readonly interrupted: Array<{ sessionId: string; turn: number; reason: string }> = [];
  readonly turnCalls: Array<ScriptedTurnCall<E, TTurnInput>> = [];
  readonly subSessions: Array<{
    parentSessionId: string;
    subSessionId: string;
    spec: SubSessionSpec<unknown>;
  }> = [];

  private turnHandler: (ctx: SessionDriverContext<E, TTurnInput>) => Promise<TResult>;
  private recoverHandler?: (ctx: {
    sessionId: string;
    events: readonly E[];
    repair: TailRepairPlan;
  }) => Promise<void>;
  private interruptHandler?: (ctx: {
    sessionId: string;
    turn: number;
    reason: string;
  }) => Promise<void>;
  private subSessionHandler?: (ctx: {
    parentSessionId: string;
    subSessionId: string;
    spec: SubSessionSpec<unknown>;
    signal: AbortSignal;
  }) => Promise<unknown>;

  constructor(options?: {
    onTurn?: (ctx: SessionDriverContext<E, TTurnInput>) => Promise<TResult>;
    onRecover?: (ctx: {
      sessionId: string;
      events: readonly E[];
      repair: TailRepairPlan;
    }) => Promise<void>;
    onInterrupt?: (ctx: { sessionId: string; turn: number; reason: string }) => Promise<void>;
    onSubSession?: (ctx: {
      parentSessionId: string;
      subSessionId: string;
      spec: SubSessionSpec<unknown>;
      signal: AbortSignal;
    }) => Promise<unknown>;
  }) {
    this.turnHandler = options?.onTurn ?? (async () => undefined as TResult);
    this.recoverHandler = options?.onRecover;
    this.interruptHandler = options?.onInterrupt;
    this.subSessionHandler = options?.onSubSession;
  }

  setTurnHandler(handler: (ctx: SessionDriverContext<E, TTurnInput>) => Promise<TResult>): void {
    this.turnHandler = handler;
  }

  async recoverSession(ctx: {
    sessionId: string;
    events: readonly E[];
    repair: TailRepairPlan;
  }): Promise<void> {
    this.recovered.push(ctx);
    await this.recoverHandler?.(ctx);
  }

  async runTurn(ctx: SessionDriverContext<E, TTurnInput>): Promise<TResult> {
    this.turnCalls.push({
      sessionId: ctx.sessionId,
      turn: ctx.turn,
      input: ctx.input,
      signal: ctx.signal,
      ctx,
    });
    return this.turnHandler(ctx);
  }

  async interruptTurn(ctx: { sessionId: string; turn: number; reason: string }): Promise<void> {
    this.interrupted.push(ctx);
    await this.interruptHandler?.(ctx);
  }

  async runSubSession<TSubInput, TSubResult = void>(ctx: {
    parentSessionId: string;
    subSessionId: string;
    spec: SubSessionSpec<TSubInput>;
    signal: AbortSignal;
  }): Promise<TSubResult> {
    this.subSessions.push({
      parentSessionId: ctx.parentSessionId,
      subSessionId: ctx.subSessionId,
      spec: ctx.spec,
    });
    if (this.subSessionHandler !== undefined) {
      return (await this.subSessionHandler(ctx)) as TSubResult;
    }
    return undefined as TSubResult;
  }
}
