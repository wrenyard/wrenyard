import { formatDuration, formatTokens, statusLabel } from '../ledger-view.js';
import type { CallEvent } from '../types.js';
import { Details, JsonValue } from './Details.js';

export function CallDetails({ event }: { event: CallEvent }) {
  const usage = event.usage;
  const label = `${event.role} · ${event.model} · ${statusLabel(event.status)} · ${formatDuration(event.startedAt, event.endedAt)}
    · 输入 ${formatTokens(usage?.input)} / 缓存 ${formatTokens(usage?.cachedInput)} / 输出 ${formatTokens(usage?.output)} / 推理 ${formatTokens(usage?.reasoning)}`;
  return <Details label={label}>
    <p>估算输入：{event.estimatedInputTokens} token</p>
    <JsonValue value={event.layers} />
    <pre>{event.output}</pre>
    {event.reasoning && <Details label="Thinking"><pre>{event.reasoning}</pre></Details>}
    {event.error && <pre className="sv2-error">{event.error}</pre>}
  </Details>;
}
