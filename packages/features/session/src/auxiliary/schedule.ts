/**
 * The schedule auxiliary task.
 *
 * It manages the scheduled prompts of this session through the daemon's
 * `schedule.*` protocol methods, like the `/loop` command. A scheduled prompt
 * is sent to the same session as a new user message when it is due. Unlike the
 * project task this session builds its tools directly instead of through
 * `protocolTools`, so the program pre-fills the current session id and the
 * model of the current turn: the model only states the prompt, the interval in
 * whole minutes and whether the schedule repeats.
 */

import type {
  ActionExecutionOutcome,
  ActionRunContext,
  ActionRunnerDeps,
  ParsedAction,
} from '../reasoning/actions.ts';
import type { LedgerEvent } from '../ledger/store.ts';
import {
  buildAuxiliaryUser,
  createLoopRecord,
  errorCodeOf,
  errorResult,
  jsonResult,
  messageOf,
  runAuxiliaryLoop,
  toActionOutcome,
  type LoopTool,
} from '../loop/loop.ts';

/** Rounds the schedule loop may run before it fails. */
const SCHEDULE_MAX_ROUNDS = 8;

/** Start one schedule session for a parsed action. */
export async function runScheduleAction(
  deps: ActionRunnerDeps,
  action: ParsedAction,
  ctx: ActionRunContext,
): Promise<ActionExecutionOutcome> {
  const record = createLoopRecord();
  const result = await runAuxiliaryLoop({
    deps,
    ctx,
    role: 'schedule',
    system: scheduleSystemPrompt(),
    user: buildAuxiliaryUser(ctx, action.intent),
    tools: scheduleTools(deps, ctx),
    maxRounds: SCHEDULE_MAX_ROUNDS,
    spanIdPrefix: 'schedule',
  });
  return toActionOutcome(result, record);
}

/**
 * The schedule tools. Every tool forwards its parsed arguments to a daemon
 * `schedule.*` method with this session's id pre-filled; `schedule_create` also
 * pre-fills the model of the current turn. A successful call returns the
 * compact JSON result; a rejected call keeps its code and message as an error
 * result and never aborts the loop.
 */
function scheduleTools(deps: ActionRunnerDeps, ctx: ActionRunContext): LoopTool[] {
  const byId = {
    type: 'object',
    properties: { id: { type: 'string', description: 'The schedule id.' } },
    required: ['id'],
    additionalProperties: false,
  };
  return [
    {
      spec: {
        name: 'schedule_list',
        description: 'List the scheduled prompts of this session.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
      run: () => callMethod(deps, 'schedule.list', { sessionId: ctx.sessionId }),
    },
    {
      spec: {
        name: 'schedule_create',
        description: 'Create one scheduled prompt for this session.',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'What to do each time the schedule runs.' },
            intervalMinutes: { type: 'integer', minimum: 1, maximum: 10080, description: 'The interval in whole minutes.' },
            recurring: { type: 'boolean', description: 'True to repeat, false to run only once.' },
          },
          required: ['prompt', 'intervalMinutes', 'recurring'],
          additionalProperties: false,
        },
      },
      run: async (args) => {
        const model = currentTurnModel(ctx);
        if (model === undefined) {
          return errorResult('model_unavailable', 'The model of the current turn is not available; cannot create a schedule.');
        }
        return callMethod(deps, 'schedule.create', { ...args, sessionId: ctx.sessionId, model });
      },
    },
    {
      spec: {
        name: 'schedule_pause',
        description: 'Pause one scheduled prompt of this session by its id.',
        parameters: byId,
      },
      run: (args) => callMethod(deps, 'schedule.update', { id: args.id, state: 'paused', sessionId: ctx.sessionId }),
    },
    {
      spec: {
        name: 'schedule_resume',
        description: 'Resume one paused scheduled prompt of this session by its id.',
        parameters: byId,
      },
      run: (args) => callMethod(deps, 'schedule.update', { id: args.id, state: 'active', sessionId: ctx.sessionId }),
    },
    {
      spec: {
        name: 'schedule_run',
        description: 'Run one scheduled prompt of this session now by its id, keeping its schedule.',
        parameters: byId,
      },
      run: (args) => callMethod(deps, 'schedule.run', { id: args.id, sessionId: ctx.sessionId }),
    },
    {
      spec: {
        name: 'schedule_delete',
        description: 'Delete one scheduled prompt of this session by its id.',
        parameters: byId,
      },
      run: (args) => callMethod(deps, 'schedule.delete', { id: args.id, sessionId: ctx.sessionId }),
    },
  ];
}

/** Call one daemon method and turn its outcome into a tool result. */
async function callMethod(
  deps: ActionRunnerDeps,
  method: string,
  params: Record<string, unknown>,
): Promise<string> {
  try {
    return jsonResult(await deps.host.call(method, params));
  } catch (error) {
    return errorResult(errorCodeOf(error), messageOf(error));
  }
}

/**
 * The model the current turn was started with, read from its `turn.started`
 * ledger event. Absent when the event, the model or its reasoning effort is
 * missing, in which case a schedule cannot be created.
 */
function currentTurnModel(
  ctx: ActionRunContext,
): { provider: string; model: string; reasoningEffort: string } | undefined {
  const started = ctx.currentEvents().find(
    (event): event is Extract<LedgerEvent, { type: 'turn.started' }> =>
      event.type === 'turn.started' && event.turn === ctx.turn,
  );
  const model = started?.model;
  if (model === undefined || model.reasoningEffort === undefined) return undefined;
  return { provider: model.provider, model: model.model, reasoningEffort: model.reasoningEffort };
}

/** The system prompt: the scheduled-prompt rules. */
function scheduleSystemPrompt(): string {
  return [
    'You are the schedule operator of a Wrenyard session. You manage the scheduled prompts of this session through the tools, like the /loop command. A scheduled prompt is sent to this same session as a new user message when it is due, using the model of the current turn.',
    '',
    'Tools:',
    '- schedule_list: list the scheduled prompts of this session.',
    '- schedule_create: create one scheduled prompt. State the prompt, the interval in whole minutes and whether it repeats.',
    '- schedule_pause: pause one scheduled prompt by its id.',
    '- schedule_resume: resume one paused scheduled prompt by its id.',
    '- schedule_run: run one scheduled prompt now by its id, keeping its schedule.',
    '- schedule_delete: delete one scheduled prompt by its id.',
    '',
    'Rules:',
    '- The interval is a whole number of minutes, at least 1 and at most 10080 (7 days).',
    '- Convert hours and days to minutes; round seconds up to whole minutes.',
    '- "every N ..." means recurring true. "in N minutes", "after N minutes" or "once" means recurring false.',
    '- When the intent gives no interval, use 10 minutes and say so.',
    '- The prompt is what to do each time. Write it without the timing words and without asking to schedule again.',
    '- A recurring schedule expires 7 days after it is created.',
    '- A due schedule waits while the session is busy; several missed runs collapse into one.',
    '- Create only what the intent asks for.',
    '- To pause, resume, run or delete, call schedule_list first when the intent does not give an id, and change only the schedules the intent names.',
    '- If the target is ambiguous, finish with done failed and list the candidates.',
    '- Finish with done and a summary of one to three sentences giving the id, the prompt, the interval, whether it repeats and the next run time.',
  ].join('\n');
}
