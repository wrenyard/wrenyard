import { ChevronRight } from 'lucide-react';
import { Markdown } from '@/renderer/components/markdown';
import { JsonView } from '@/renderer/components/json-view';
import { StatusBadge } from '@/renderer/components/status-badge';
import { Elapsed } from '@/renderer/components/elapsed';
import { CopyButton } from '@/renderer/components/copy-button';
import { Button } from '@/renderer/components/ui/button';
import { Separator } from '@/renderer/components/ui/separator';
import { formatClockSeconds, formatDateTime } from '@/renderer/lib/format';
import { itemStatusLabel, materialTitle } from '../../model/describe.js';
import type {
  ActionModel,
  BlockModel,
  CallModel,
  ContextItem,
  CycleModel,
  InspectorTarget,
  SessionModel,
  TurnModel,
} from '../../model/types.js';
import { TurnMeta } from '../TurnMeta.js';

interface Crumb {
  label: string;
  target?: InspectorTarget;
}

function findTurn(model: SessionModel, id: number): TurnModel | undefined {
  return model.turns.find((turn) => turn.id === id);
}

function findCycle(turn: TurnModel, index: number): CycleModel | undefined {
  return turn.cycles.find((cycle) => cycle.index === index);
}

function findAction(turn: TurnModel, actionId: string): ActionModel | undefined {
  return turn.actions.find((action) => action.id === actionId);
}

function findBlock(turn: TurnModel, blockId: string): { block: BlockModel; cycle: CycleModel } | undefined {
  for (const cycle of turn.cycles) {
    const block = cycle.blocks.find((candidate) => candidate.blockId === blockId);
    if (block) return { block, cycle };
  }
  return undefined;
}

function findContext(turn: TurnModel, key: string): { item: ContextItem; cycle?: CycleModel; action?: ActionModel } | undefined {
  for (const cycle of turn.cycles) {
    const item = cycle.context.find((candidate) => candidate.key === key);
    if (item) return { item, cycle };
  }
  for (const action of turn.actions) {
    const item = action.outputs.find((candidate) => candidate.key === key);
    if (item) return { item, action };
  }
  return undefined;
}

function breadcrumbs(model: SessionModel, target: InspectorTarget): Crumb[] {
  if (target.kind === 'call') {
    const call = model.calls.find((candidate) => candidate.id === target.callId);
    const turn = call ? findTurn(model, call.turn) : undefined;
    return [
      ...(turn ? [{ label: `轮次 ${turn.id}`, target: { kind: 'turn', turnId: turn.id } as InspectorTarget }] : []),
      ...(turn && call?.cycle ? [{ label: `第 ${call.cycle} 次推理`, target: { kind: 'cycle', turnId: turn.id, cycle: call.cycle } as InspectorTarget }] : []),
      { label: target.callId },
    ];
  }
  const turn = findTurn(model, target.turnId);
  if (!turn) return [{ label: '详情' }];
  const crumbs: Crumb[] = [{ label: `轮次 ${turn.id}`, target: { kind: 'turn', turnId: turn.id } }];
  if (target.kind === 'turn') return crumbs;
  if (target.kind === 'cycle' || target.kind === 'reasoning') {
    crumbs.push({ label: `第 ${target.cycle} 次推理` });
    return crumbs;
  }
  const cycle = target.kind === 'action'
    ? findAction(turn, target.actionId)?.cycle
    : target.kind === 'block'
      ? findBlock(turn, target.blockId)?.cycle.index
      : target.kind === 'context'
        ? target.cycle ?? findContext(turn, target.key)?.cycle?.index
        : undefined;
  if (cycle !== undefined && cycle > 0) {
    crumbs.push({ label: `第 ${cycle} 次推理`, target: { kind: 'cycle', turnId: turn.id, cycle } });
  }
  const leaf = target.kind === 'action' ? target.actionId : target.kind === 'block' ? target.blockId : target.kind === 'context' ? '资料' : '推理';
  crumbs.push({ label: leaf });
  return crumbs;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] items-start gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  );
}

function MaterialDetail({ item }: { item: ContextItem }) {
  return (
    <div className="flex flex-col gap-3">
      <Field label="路径"><span className="font-mono text-xs break-all">{item.path}</span></Field>
      <Field label="类型">{item.kind === 'memory' ? '记忆' : item.kind === 'instructions' ? '项目指令' : '文档'}</Field>
      <Field label="来源">{item.source === 'selection' ? '上下文选择' : item.source === 'action' ? '行动加载' : '项目指令'}</Field>
      {item.reason && <Field label="理由">{item.reason}</Field>}
      <Separator />
      <Markdown>{item.content}</Markdown>
    </div>
  );
}

function UsageTable({ usage }: { usage: NonNullable<CallModel['usage']> }) {
  return (
    <div className="overflow-hidden rounded-md border border-border text-xs">
      <table className="w-full">
        <tbody>
          {[['输入', usage.input], ['缓存输入', usage.cachedInput], ['输出', usage.output], ['推理', usage.reasoning]]
            .filter(([, value]) => value !== undefined)
            .map(([label, value]) => (
              <tr key={label as string} className="border-b border-border last:border-0">
                <td className="px-2 py-1 text-muted-foreground">{label}</td>
                <td className="px-2 py-1 text-right font-mono">{(value as number).toLocaleString()}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

function Layers({ layers }: { layers: Record<string, number> }) {
  const entries = Object.entries(layers).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, value]) => value));
  return (
    <div className="flex flex-col gap-1">
      {entries.map(([name, value]) => (
        <div key={name} className="grid grid-cols-[8rem_1fr_3.5rem] items-center gap-2 text-xs">
          <span className="truncate text-muted-foreground">{name}</span>
          <span className="h-2 rounded-full bg-primary/60" style={{ width: `${(value / max) * 100}%` }} />
          <span className="text-right font-mono">{value.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

function ActionDetail({ turn, action, onSelect }: { turn: TurnModel; action: ActionModel; onSelect: (target: InspectorTarget) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{action.title}</span>
        <StatusBadge status={action.status} label={itemStatusLabel(action.status)} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Field label="开始"><span className="font-mono text-xs" title={formatDateTime(action.startedAt)}>{formatClockSeconds(action.startedAt)}</span></Field>
        <Field label="结束">{action.endedAt ? <span className="font-mono text-xs" title={formatDateTime(action.endedAt)}>{formatClockSeconds(action.endedAt)}</span> : '进行中'}</Field>
        <Field label="用时"><Elapsed start={action.startedAt} end={action.endedAt} /></Field>
      </div>
      {action.parsed !== undefined && (
        <Section title="解析结果"><JsonView value={action.parsed} /></Section>
      )}
      {action.result && (
        <Section title="结果全文"><Markdown size="sm">{action.result}</Markdown></Section>
      )}
      {action.outputs.length > 0 && (
        <Section title="加载的资料">
          <div className="flex flex-col gap-1">
            {action.outputs.map((item) => (
              <button key={item.key} type="button" className="text-left text-sm hover:underline"
                onClick={() => onSelect({ kind: 'context', turnId: turn.id, key: item.key, ...(action.cycle ? { cycle: action.cycle } : {}) })}>
                {materialTitle(item)}
              </button>
            ))}
          </div>
        </Section>
      )}
      {action.writes.length > 0 && (
        <Section title="写入">
          <div className="flex flex-col gap-1 text-sm">
            {action.writes.map((write) => (
              <span key={write.path} className="font-mono text-xs">
                {write.path}（{write.change === 'created' ? '新建' : '更新'}）
              </span>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function BlockDetail({ turn, block, cycle, onSelect }: { turn: TurnModel; block: BlockModel; cycle: CycleModel; onSelect: (target: InspectorTarget) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <Field label="所属循环">第 {cycle.index} 次推理</Field>
      <Field label="状态">{block.unterminated ? '未闭合' : '完整'}</Field>
      <Section title="原文">
        <pre className="overflow-x-auto rounded-md bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap">{block.text}</pre>
      </Section>
      <Section title="解析出的行动">
        {block.actionIds.length === 0
          ? <p className="text-sm text-muted-foreground">没有行动</p>
          : <div className="flex flex-col gap-1">
            {block.actionIds.map((actionId) => {
              const action = findAction(turn, actionId);
              return (
                <button key={actionId} type="button" className="text-left text-sm hover:underline"
                  onClick={() => onSelect({ kind: 'action', turnId: turn.id, actionId })}>
                  {action?.title ?? actionId}
                </button>
              );
            })}
          </div>}
      </Section>
    </div>
  );
}

function CallDetail({ call, onSelect }: { call: CallModel; onSelect: (target: InspectorTarget) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{call.role} · {call.model}</span>
        <StatusBadge status={call.status} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Field label="开始"><span className="font-mono text-xs" title={formatDateTime(call.startedAt)}>{formatClockSeconds(call.startedAt)}</span></Field>
        {call.endedAt && <Field label="结束"><span className="font-mono text-xs" title={formatDateTime(call.endedAt)}>{formatClockSeconds(call.endedAt)}</span></Field>}
        <Field label="总用时"><Elapsed start={call.startedAt} end={call.endedAt} /></Field>
        {call.estimatedInputTokens !== undefined && <Field label="估算输入">{call.estimatedInputTokens.toLocaleString()} token</Field>}
      </div>
      {call.usage && <Section title="用量"><UsageTable usage={call.usage} /></Section>}
      {call.layers && Object.keys(call.layers).length > 0 && <Section title="分层字符数"><Layers layers={call.layers} /></Section>}
      {call.error && <Section title="错误"><span className="text-sm text-destructive">{call.error}</span></Section>}
      {call.output && <Section title="输出"><Markdown size="sm">{call.output}</Markdown></Section>}
      {call.reasoning && (
        <Section title="Thinking">
          <pre className="overflow-x-auto rounded-md bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap">{call.reasoning}</pre>
        </Section>
      )}
    </div>
  );
}

export interface DetailPaneProps {
  model: SessionModel;
  target: InspectorTarget | undefined;
  onSelect: (target: InspectorTarget) => void;
}

/** Details of the inspected object; defaults to the latest turn. */
export function DetailPane({ model, target, onSelect }: DetailPaneProps) {
  const resolved: InspectorTarget = target ?? (model.turns.length > 0
    ? { kind: 'turn', turnId: model.turns[model.turns.length - 1]!.id }
    : { kind: 'turn', turnId: 0 });
  const crumbs = breadcrumbs(model, resolved);

  return (
    <div className="flex flex-col gap-4 p-3">
      <nav className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground" aria-label="面包屑">
        {crumbs.map((crumb, index) => (
          <span key={`${crumb.label}-${index}`} className="flex items-center gap-1">
            {index > 0 && <ChevronRight className="size-3" />}
            {crumb.target && index < crumbs.length - 1 ? (
              <button type="button" className="hover:text-foreground hover:underline" onClick={() => onSelect(crumb.target!)}>
                {crumb.label}
              </button>
            ) : (
              <span className={index === crumbs.length - 1 ? 'text-foreground' : undefined}>{crumb.label}</span>
            )}
          </span>
        ))}
      </nav>
      <Separator />
      <TargetBody model={model} target={resolved} onSelect={onSelect} />
    </div>
  );
}

function TargetBody({ model, target, onSelect }: { model: SessionModel; target: InspectorTarget; onSelect: (target: InspectorTarget) => void }) {
  if (target.kind === 'call') {
    const call = model.calls.find((candidate) => candidate.id === target.callId);
    return call ? <CallDetail call={call} onSelect={onSelect} /> : <Empty text="找不到这个调用" />;
  }
  const turn = findTurn(model, target.turnId);
  if (!turn) return <Empty text="找不到这个轮次" />;

  switch (target.kind) {
    case 'turn':
      return (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Field label="模型">{`${turn.model.provider}/${turn.model.model}`}</Field>
            {turn.model.reasoningEffort && <Field label="推理强度">{turn.model.reasoningEffort}</Field>}
            <Field label="状态">{turn.status}</Field>
          </div>
          <Separator />
          <TurnMeta turn={turn} />
        </div>
      );
    case 'cycle': {
      const cycle = findCycle(turn, target.cycle);
      return cycle ? <CycleDetail turn={turn} cycle={cycle} onSelect={onSelect} /> : <Empty text="找不到这个循环" />;
    }
    case 'reasoning': {
      const cycle = findCycle(turn, target.cycle);
      if (!cycle?.reasoning) return <Empty text="没有推理内容" />;
      return (
        <div className="flex flex-col gap-4">
          <Field label="调用">
            <button type="button" className="hover:underline" onClick={() => onSelect({ kind: 'call', callId: cycle.reasoning!.callId })}>
              {cycle.reasoning.callId}
            </button>
          </Field>
          <Section title="可见输出"><Markdown>{cycle.reasoning.text}</Markdown></Section>
          {cycle.reasoning.thinking && (
            <Section title="Thinking">
              <pre className="overflow-x-auto rounded-md bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap">{cycle.reasoning.thinking}</pre>
            </Section>
          )}
        </div>
      );
    }
    case 'context': {
      const found = findContext(turn, target.key);
      return found ? <MaterialDetail item={found.item} /> : <Empty text="找不到这份资料" />;
    }
    case 'action': {
      const action = findAction(turn, target.actionId);
      return action ? <ActionDetail turn={turn} action={action} onSelect={onSelect} /> : <Empty text="找不到这个行动" />;
    }
    case 'block': {
      const found = findBlock(turn, target.blockId);
      return found ? <BlockDetail turn={turn} block={found.block} cycle={found.cycle} onSelect={onSelect} /> : <Empty text="找不到这个标注块" />;
    }
  }
}

function CycleDetail({ turn, cycle, onSelect }: { turn: TurnModel; cycle: CycleModel; onSelect: (target: InspectorTarget) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <Field label="循环">第 {cycle.index} 次推理</Field>
      <Field label="开始"><span className="font-mono text-xs" title={formatDateTime(cycle.startedAt)}>{formatClockSeconds(cycle.startedAt)}</span></Field>
      <Field label="用时"><Elapsed start={cycle.startedAt} end={cycle.endedAt} /></Field>
      {cycle.reasoning && (
        <Section title="推理">
          <Button variant="outline" size="sm" onClick={() => onSelect({ kind: 'reasoning', turnId: turn.id, cycle: cycle.index })}>
            查看推理全文
          </Button>
        </Section>
      )}
      {cycle.context.length > 0 && (
        <Section title="准备">
          <div className="flex flex-col gap-1">
            {cycle.context.map((item) => (
              <button key={item.key} type="button" className="text-left text-sm hover:underline"
                onClick={() => onSelect({ kind: 'context', turnId: turn.id, cycle: cycle.index, key: item.key })}>
                {materialTitle(item)}
              </button>
            ))}
          </div>
        </Section>
      )}
      {cycle.actionIds.length > 0 && (
        <Section title="行动">
          <div className="flex flex-col gap-1">
            {cycle.actionIds.map((actionId) => (
              <button key={actionId} type="button" className="text-left text-sm hover:underline"
                onClick={() => onSelect({ kind: 'action', turnId: turn.id, actionId })}>
                {findAction(turn, actionId)?.title ?? actionId}
              </button>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="text-sm text-muted-foreground">{text}</p>;
}
