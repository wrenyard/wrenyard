/**
 * Bot turn loop driver: the agent-loop variant for sessions whose host provides
 * an {@link AgentToolPort}.
 */

import type { ToolCall } from '@wrenyard/ai/transport';
import type { ActionExecutionOutcome, ParsedAction, SessionCallHost } from '../ports.ts';
import type { ReplyWriter } from '../auxiliary/reply.ts';
import { Compaction } from '../context/compaction.ts';
import { TurnActionExecutor, auxiliaryToolRequest } from './executor.ts';
import { TurnLoop, type LoopAgent } from './orchestrator.ts';
import type { SessionRuntime, TurnRuntime } from './runtime.ts';

/** Action execution for native bot tools, re-read from the host per call. */
class BotActionExecutor extends TurnActionExecutor {
  override async handleToolCall(
    session: SessionRuntime,
    turn: TurnRuntime,
    step: number,
    call: ToolCall,
    _workerLines: string[],
  ): Promise<void> {
    const port = this.port(session);
    turn.toolCallsThisStep += 1;
    const tool = port?.tools.find((candidate) => candidate.name === call.name);
    if (port === undefined || tool === undefined) {
      turn.correctionRequired = true;
      await this.engine.appendError(session.sessionId, 'reason', `unknown tool: ${call.name}`, turn, step);
      return;
    }
    const auxiliary = port.auxiliaryTools?.[call.name];
    if (auxiliary !== undefined) {
      const request = auxiliaryToolRequest(call.arguments);
      if (request === undefined) {
        turn.correctionRequired = true;
        await this.engine.appendError(
          session.sessionId,
          'reason',
          `invalid arguments for tool ${call.name}: expected a non-empty "request" string`,
          turn,
          step,
        );
        return;
      }
      await this.startAction(session, turn, step, { type: auxiliary, intent: request, name: call.name });
      return;
    }
    await this.startAction(session, turn, step, { type: 'tool', name: call.name, intent: call.arguments });
  }

  protected override async runToolAction(
    session: SessionRuntime,
    turn: TurnRuntime,
    action: ParsedAction,
  ): Promise<ActionExecutionOutcome> {
    const port = this.port(session);
    if (port === undefined) {
      return { status: 'failed', result: `unknown tool: ${action.name ?? ''}`, deferred: [] };
    }
    const result = await port.run(
      { name: action.name ?? '', arguments: action.intent },
      { sessionId: session.sessionId, turn: turn.turn },
    );
    return { status: result.status === 'done' ? 'done' : 'failed', result: result.result, deferred: [] };
  }

  private port(session: SessionRuntime) {
    return this.engine.host.agentTools?.(session.sessionId);
  }
}

/** Run bot turns on the host's agent tool port. */
export class BotLoop extends TurnLoop {
  constructor(engine: SessionCallHost, replies: ReplyWriter) {
    super(engine, replies, new BotActionExecutor(engine), new Compaction(engine));
  }

  protected agent(session: SessionRuntime): LoopAgent {
    const port = this.engine.host.agentTools?.(session.sessionId);
    if (port === undefined) return { tools: [] };
    return {
      tools: port.tools,
      system: port.system,
      ...(port.kernelFacts === undefined ? {} : { kernelFacts: () => port.kernelFacts?.() }),
    };
  }
}
