import type { LedgerEvent, TurnView } from './types.js';

/** Snapshot and live pushes may overlap. Sequence numbers are session-local. */
export function mergeEvents(current: LedgerEvent[], incoming: LedgerEvent[]): LedgerEvent[] {
  const bySequence = new Map(current.map((event) => [event.seq, event]));
  for (const event of incoming) bySequence.set(event.seq, event);
  return [...bySequence.values()].sort((a, b) => a.seq - b.seq);
}

export function deriveTurns(events: LedgerEvent[]): TurnView[] {
  const turns = new Map<number, TurnView>();
  for (const event of events) {
    if (event.turn === undefined) continue;
    let turn = turns.get(event.turn);
    if (!turn) {
      turn = { id: event.turn, events: [], cycle: 0, phase: '准备', started: event.at, user: '', progress: '' };
      turns.set(event.turn, turn);
    }
    turn.events.push(event);
    turn.cycle = Math.max(turn.cycle, event.cycle ?? 0);
    if (event.type === 'turn.started') { turn.user = event.text; turn.started = event.at; }
    if (event.type === 'reply') {
      if (event.phase === 'final') turn.final = event.text;
      else turn.progress = event.text;
    }
    if (event.type === 'turn.finished') { turn.status = event.status; turn.ended = event.at; }
    if (turn.status) continue;
    if (event.type === 'call' && event.role === 'select') turn.phase = '准备';
    if (event.type === 'context.selected' || event.type === 'action.block') turn.phase = '推理';
    if (event.type === 'action.started') turn.phase = '行动';
    if (event.type === 'reason.completed') {
      turn.phase = turn.events.some((item) => item.cycle === event.cycle && item.type === 'action.block') ? '行动' : '回复';
    }
    if (event.type === 'reply' && event.phase === 'final') turn.phase = '回复';
  }
  return [...turns.values()].sort((a, b) => a.id - b.id);
}

export function formatDuration(start: string, end?: string, now = Date.now()): string {
  return `${Math.max(0, Math.floor(((end ? Date.parse(end) : now) - Date.parse(start)) / 1000))} 秒`;
}

export function formatTokens(value: number | undefined): string {
  return value === undefined ? '—' : value.toLocaleString();
}

const STATUS_LABELS: Record<string, string> = {
  completed: '已完成', exhausted: '已达推理上限', failed: '失败', interrupted: '已中断',
  ok: '成功', aborted: '已取消', running: '运行中', skipped: '已跳过',
};
export function statusLabel(status: string): string { return STATUS_LABELS[status] ?? status; }

export function turnStats(turn: TurnView): string {
  const calls = turn.events.filter((event) => event.type === 'call');
  return [true, false].map((expensive) => {
    const subset = calls.filter((call) => (call.role === 'reason') === expensive);
    const sum = (key: 'input' | 'output'): string => {
      const known = subset.flatMap((call) => call.usage?.[key] === undefined ? [] : [call.usage[key]!]);
      return known.length
        ? formatTokens(known.reduce((a, b) => a + b, 0)) + (known.length < subset.length ? '（部分）' : '')
        : '—';
    };
    return `${expensive ? '昂贵' : '便宜'}调用 ${subset.length} · 输入 ${sum('input')} / 输出 ${sum('output')}`;
  }).join('；') + `；${formatDuration(turn.started, turn.ended)}；${statusLabel(turn.status ?? 'running')}`;
}
