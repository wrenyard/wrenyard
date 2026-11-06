/**
 * bot turn loop: the agent-loop variant for sessions whose host provides an
 * agent tool port. A model output with no tool call ends the turn, so there is
 * no separate `done` tool; tools are dispatched by name through the port, with
 * `workspace` still mapping onto the built-in `vcs` action.
 */

import type { ActionExecutionOutcome, ParsedAction } from '../reasoning/actions.ts';
import type { ToolCall } from '../transport/index.ts';
import type { ReplyWriter } from '../auxiliary/reply.ts';
import type { SessionCallHost } from '../ports.ts';
import { ActionRunner, auxiliaryToolRequest } from './actions.ts';
import { Compaction } from './compaction.ts';
import { TurnLoop, type LoopAgent } from './native-loop.ts';
import type { SessionRuntime, TurnRuntime } from './runtime.ts';

/** Action execution for native bot tools, re-read from the host per call. */
class BotActionRunner extends ActionRunner {
  override async handleToolCall(
    session: SessionRuntime,
    turn: TurnRuntime,
    step: number,
    call: ToolCall,
    workerLines: string[],
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
    super(engine, replies, new BotActionRunner(engine), new Compaction(engine));
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
