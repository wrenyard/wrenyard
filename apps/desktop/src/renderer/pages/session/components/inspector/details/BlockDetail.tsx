import { Item, ItemContent } from '@/renderer/components/ui/item';
import type { BlockModel, CycleModel, InspectorTarget, TurnModel } from '../../../model/types.js';
import { Field, Fields, InspectLink, Section, findAction } from '../parts.js';

/** One reasoning block: raw markup plus the actions parsed out of it. */
export function BlockDetail({ turn, block, cycle, onSelect }: { turn: TurnModel; block: BlockModel; cycle: CycleModel; onSelect: (target: InspectorTarget) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <Fields>
        <Field label="所属循环">第 {cycle.index} 次推理</Field>
        <Field label="状态">{block.unterminated ? '未闭合' : '完整'}</Field>
      </Fields>
      <Section title="原文">
        <Item variant="muted">
          <ItemContent>
            <pre className="overflow-x-auto whitespace-pre-wrap">{block.text}</pre>
          </ItemContent>
        </Item>
      </Section>
      <Section title="解析出的行动">
        {block.actionIds.length === 0
          ? <p className="text-sm text-muted-foreground">没有行动</p>
          : <div className="flex flex-col gap-1">
            {block.actionIds.map((actionId) => (
              <InspectLink key={actionId} onClick={() => onSelect({ kind: 'action', turnId: turn.id, actionId })}>
                {findAction(turn, actionId)?.title ?? actionId}
              </InspectLink>
            ))}
          </div>}
      </Section>
    </div>
  );
}
