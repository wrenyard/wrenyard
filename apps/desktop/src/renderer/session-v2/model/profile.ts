import type { TimelineBar, TimelineLane, TimelineRange } from '@/renderer/components/timeline-bars';
import { cycleLabel } from './describe.js';
import type { ActionModel, CallModel, Phase, TurnModel } from './types.js';

export interface TurnProfile {
  range: TimelineRange;
  lanes: TimelineLane[];
  summary: {
    wallMs: number;
    phases: { phase: Phase; label: string; ms: number }[];
    reasonWaitMs: number;
    reasonOutputMs: number;
    calls: number;
  };
}

const PHASE_LABEL: Record<Phase, string> = {
  preparing: '准备',
  reasoning: '推理',
  acting: '行动',
  replying: '回复',
};

const CALL_ROLE_LABEL: Record<CallModel['role'], string> = {
  reason: '推理',
  select: '选择',
  interpret: '解析',
  compile: '编译',
  write: '写文档',
  reply: '回复',
  title: '标题',
};

const ACTION_TONE: Record<ActionModel['status'], string> = {
  running: 'running',
  done: 'done',
  failed: 'failed',
  skipped: 'skipped',
  cancelled: 'cancelled',
  aborted: 'cancelled',
};

function ms(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function callEnd(call: CallModel, fallback: number): number {
  return call.endedAt === undefined ? fallback : ms(call.endedAt);
}

/** Builds the phase / call / action lanes and the summary table for one turn. */
export function buildTurnProfile(turn: TurnModel, now: number): TurnProfile {
  const start = ms(turn.startedAt);
  const rawEnd = turn.endedAt === undefined ? now : ms(turn.endedAt);
  const end = Math.max(start + 1, rawEnd);
  const range: TimelineRange = { start, end };

  const reasonCalls = turn.calls.filter((call) => call.role === 'reason').sort((a, b) => ms(a.startedAt) - ms(b.startedAt));
  const phaseBars: TimelineBar[] = [];
  const phaseTotals = new Map<Phase, number>();
  const addPhase = (phase: Phase, from: number, to: number): void => {
    if (to <= from) return;
    phaseBars.push({ id: `phase-${phase}-${phaseBars.length}`, start: from, end: to, tone: phase, label: PHASE_LABEL[phase] });
    phaseTotals.set(phase, (phaseTotals.get(phase) ?? 0) + (to - from));
  };

  let cursor = start;
  for (const call of reasonCalls) {
    const callStart = ms(call.startedAt);
    const outEnd = callEnd(call, end);
    addPhase('preparing', cursor, callStart);
    addPhase('reasoning', callStart, outEnd);
    cursor = Math.max(cursor, outEnd);
    const cycleActions = turn.actions.filter((action) => action.cycle === call.cycle);
    if (cycleActions.length > 0) {
      const actionStart = Math.min(...cycleActions.map((action) => ms(action.startedAt)));
      const actionEnd = Math.max(...cycleActions.map((action) => (action.endedAt === undefined ? end : ms(action.endedAt))));
      addPhase('preparing', cursor, actionStart);
      addPhase('acting', actionStart, actionEnd);
      cursor = Math.max(cursor, actionEnd);
    }
  }
  if (turn.final || turn.actions.length > 0 || reasonCalls.length === 0) {
    addPhase('replying', cursor, end);
  }

  const lanes: TimelineLane[] = [
    {
      id: 'phase',
      label: '阶段',
      bars: phaseBars,
    },
  ];

  // Reason calls: one shared lane, every call's wait/output segments concatenated in time order.
  let waitTotal = 0;
  let outputTotal = 0;
  const reasonBars: TimelineBar[] = [];
  for (const call of reasonCalls) {
    const callStart = ms(call.startedAt);
    const outEnd = callEnd(call, end);
    const firstToken = call.firstTokenAt === undefined ? undefined : ms(call.firstTokenAt);
    const cycle = cycleLabel(call.cycle ?? 1);
    if (firstToken !== undefined && firstToken > callStart) {
      waitTotal += firstToken - callStart;
      outputTotal += Math.max(0, outEnd - firstToken);
      reasonBars.push({ id: `${call.id}#wait`, start: callStart, end: firstToken, tone: 'reason-wait', label: `${cycle} · 等待首 token`, detail: `${firstToken - callStart}ms` });
      reasonBars.push({ id: call.id, start: firstToken, end: outEnd, tone: 'reason-output', label: `${cycle} · 输出` });
    } else {
      outputTotal += Math.max(0, outEnd - callStart);
      reasonBars.push({ id: call.id, start: callStart, end: outEnd, tone: 'reason-output', label: `${cycle} · 输出` });
    }
  }
  if (reasonCalls.length > 0) {
    lanes.push({ id: 'reason', label: '推理', bars: reasonBars });
  }

  // Cheap calls: one set of overlapping rows per role.
  const cheap = turn.calls.filter((call) => call.role !== 'reason');
  for (const role of Object.keys(CALL_ROLE_LABEL) as CallModel['role'][]) {
    if (role === 'reason') continue;
    const roleCalls = cheap.filter((call) => call.role === role).sort((a, b) => ms(a.startedAt) - ms(b.startedAt));
    if (roleCalls.length === 0) continue;
    const rows: CallModel[][] = [];
    for (const call of roleCalls) {
      const row = rows.find((candidate) => callEnd(candidate[candidate.length - 1]!, end) <= ms(call.startedAt));
      if (row) row.push(call);
      else rows.push([call]);
    }
    rows.forEach((row, index) => {
      lanes.push({
        id: `cheap-${role}-${index}`,
        label: rows.length > 1 ? `${CALL_ROLE_LABEL[role]} ${index + 1}` : CALL_ROLE_LABEL[role],
        bars: row.map((call) => ({
          id: call.id,
          start: ms(call.startedAt),
          ...(call.endedAt === undefined ? {} : { end: ms(call.endedAt) }),
          tone: 'cheap',
          label: `${CALL_ROLE_LABEL[role]} · ${call.model}`,
          detail: call.status,
        })),
      });
    });
  }

  for (const action of turn.actions) {
    lanes.push({
      id: `action-${action.id}`,
      label: action.title,
      bars: [{
        id: action.id,
        start: ms(action.startedAt),
        ...(action.endedAt === undefined ? {} : { end: ms(action.endedAt) }),
        tone: ACTION_TONE[action.status],
        label: action.title,
        detail: action.subtitle,
      }],
    });
  }

  const phases = (Object.keys(PHASE_LABEL) as Phase[]).map((phase) => ({
    phase,
    label: PHASE_LABEL[phase],
    ms: phaseTotals.get(phase) ?? 0,
  }));

  return {
    range,
    lanes,
    summary: {
      wallMs: end - start,
      phases,
      reasonWaitMs: waitTotal,
      reasonOutputMs: outputTotal,
      calls: turn.calls.length,
    },
  };
}
