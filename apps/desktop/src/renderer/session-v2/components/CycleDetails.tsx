import { Fragment } from 'react';
import type { LedgerEvent } from '../types.js';
import { ActionDetails } from './ActionDetails.js';
import { CallDetails } from './CallDetails.js';
import { Details, JsonValue } from './Details.js';

/** Text remains React text nodes, including action markup supplied by a model. */
function ReasonText({ text }: { text: string }) {
  return <pre>{text.split(/(<wy-action>[\s\S]*?<\/wy-action>)/g).map((part, index) =>
    part.startsWith('<wy-action>') && part.endsWith('</wy-action>')
      ? <mark key={index}>{part}</mark> : <Fragment key={index}>{part}</Fragment>)}</pre>;
}

export function CycleDetails({ cycle, events, interrupted }: {
  cycle: number; events: LedgerEvent[]; interrupted: boolean;
}) {
  const actionIds = new Set(events.flatMap((event) => event.type === 'action.started' ? [event.actionId] : []));
  return <section className="sv2-cycle">
    <h3>{cycle ? `第 ${cycle} 次推理` : '会话准备'}</h3>
    <h4>准备</h4>
    {events.map((event) => {
      if (event.type === 'context.selected') return <JsonValue key={event.seq} value={event.selections} />;
      if (event.type === 'doc.read' || event.type === 'memory.recalled') {
        return <Details key={event.seq} label={`${event.path} · ${event.source}`}><pre>{event.content}</pre></Details>;
      }
      return null;
    })}
    <h4>推理</h4>
    {events.map((event) => event.type === 'reason.completed' ? <ReasonText key={event.seq} text={event.text} /> : null)}
    <h4>行动</h4>
    {events.map((event) => {
      switch (event.type) {
        case 'action.block': return <ActionDetails key={event.seq} block={event} events={events} interrupted={interrupted} />;
        case 'action.finished': return actionIds.has(event.actionId) ? null
          : <pre key={event.seq}>{event.actionId} · {event.status}{'\n'}{event.result}</pre>;
        case 'ws.updated': return <p key={event.seq}>文档：{event.change} · {event.path}</p>;
        case 'error': return <pre key={event.seq} className="sv2-error">{event.stage}: {event.message}</pre>;
        default: return null;
      }
    })}
    <h4>模型调用</h4>
    {events.map((event) => event.type === 'call' ? <CallDetails key={event.seq} event={event} /> : null)}
  </section>;
}
