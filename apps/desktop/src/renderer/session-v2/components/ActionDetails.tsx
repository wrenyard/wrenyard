import { statusLabel } from '../ledger-view.js';
import type { EventOf, LedgerEvent } from '../types.js';
import { JsonValue } from './Details.js';

interface Props {
  block: EventOf<'action.block'>;
  events: LedgerEvent[];
  interrupted: boolean;
}

export function ActionDetails({ block, events, interrupted }: Props) {
  const actions = new Map<string, EventOf<'action.started'>>();
  for (const event of events) {
    if (event.type === 'action.started' && event.blockId === block.blockId) actions.set(event.actionId, event);
  }
  return <div className="sv2-action">
    <pre>{block.text}{block.unterminated ? '\n（标注未闭合）' : ''}</pre>
    {[...actions.values()].map((action) => {
      const finish = events.find((event): event is EventOf<'action.finished'> =>
        event.type === 'action.finished' && event.actionId === action.actionId);
      const taskRunId = action.taskRunId ?? finish?.taskRunId;
      return <div key={action.actionId}>
        <p>{action.actionId} · {action.kind} · {statusLabel(finish?.status ?? (interrupted ? 'interrupted' : 'running'))}</p>
        <JsonValue value={action.parsed} />
        {taskRunId && <p>任务运行：{taskRunId}</p>}
        {finish && <pre>{finish.result}</pre>}
      </div>;
    })}
  </div>;
}
