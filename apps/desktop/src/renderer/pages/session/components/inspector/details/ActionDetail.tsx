import { ExternalLink } from 'lucide-react';
import { ItemTitle } from '@/renderer/components/ui/item';
import { Button } from '@/renderer/components/ui/button';
import { Elapsed } from '@/renderer/components/elapsed';
import { JsonView } from '@/renderer/components/json-view';
import { AppMarkdown as Markdown } from '@/renderer/components/app-markdown';
import { StatusBadge } from '@/renderer/components/status-badge';
import { Timestamp } from '@/renderer/components/timestamp';
import { shell } from '@/renderer/lib/desktop';
import { materialTitle, statusView } from '../../../model/describe.js';
import type { ActionModel, InspectorTarget, TurnModel } from '../../../model/types.js';
import { Field, Fields, InspectLink, Section } from '../parts.js';

/** One action: timing, task-run details, parsed payload, outputs and writes. */
export function ActionDetail({ turn, action, onSelect }: { turn: TurnModel; action: ActionModel; onSelect: (target: InspectorTarget) => void }) {
  const transcriptId = action.taskRunId;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <ItemTitle>{action.title}</ItemTitle>
        <StatusBadge {...statusView(action.status)} />
      </div>
      <Fields>
        <Field label="开始"><Timestamp value={action.startedAt} precision="second" /></Field>
        <Field label="结束">{action.endedAt ? <Timestamp value={action.endedAt} precision="second" /> : '进行中'}</Field>
        <Field label="用时"><Elapsed start={action.startedAt} end={action.endedAt} /></Field>
        {transcriptId !== undefined && (
          <Field label="任务运行">
            <span className="flex items-center gap-2">
              <span>{transcriptId}</span>
              <Button variant="outline" onClick={() => { void shell.openTaskTranscript(transcriptId); }}>
                <ExternalLink /> 查看任务对话
              </Button>
            </span>
          </Field>
        )}
        {action.task && <Field label="任务状态"><StatusBadge {...statusView(action.task.status)} /></Field>}
        {action.task?.runtime && <Field label="运行端">{action.task.runtime}</Field>}
        {action.task?.usage && (
          <Field label="用量">
            {`输入 ${action.task.usage.input ?? '—'} · 输出 ${action.task.usage.output ?? '—'}`}
          </Field>
        )}
      </Fields>
      {action.parsed !== undefined && (
        <Section title="解析结果"><JsonView value={action.parsed} /></Section>
      )}
      {action.result && (
        <Section title="结果全文"><Markdown>{action.result}</Markdown></Section>
      )}
      {action.outputs.length > 0 && (
        <Section title="加载的资料">
          <div className="flex flex-col gap-1">
            {action.outputs.map((item) => (
              <InspectLink key={item.key}
                onClick={() => onSelect({ kind: 'context', turnId: turn.id, key: item.key, ...(action.cycle ? { cycle: action.cycle } : {}) })}>
                {materialTitle(item)}
              </InspectLink>
            ))}
          </div>
        </Section>
      )}
      {action.writes.length > 0 && (
        <Section title="写入">
          <div className="flex flex-col gap-1">
            {action.writes.map((write) => (
              <span key={write.path}>
                {write.path}（{write.change === 'created' ? '新建' : '更新'}）
              </span>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}
