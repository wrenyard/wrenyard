import { Separator } from '@/renderer/components/ui/separator';
import { Markdown } from '@/renderer/components/markdown';
import type { ContextItem } from '../../../model/types.js';
import { Field, Fields } from '../parts.js';

/** One loaded document or memory: metadata plus its full content. */
export function MaterialDetail({ item }: { item: ContextItem }) {
  return (
    <div className="flex flex-col gap-3">
      <Fields>
        <Field label="路径">{item.path}</Field>
        <Field label="类型">{item.kind === 'memory' ? '记忆' : item.kind === 'instructions' ? '项目指令' : '文档'}</Field>
        <Field label="来源">{item.source === 'selection' ? '上下文选择' : item.source === 'action' ? '行动加载' : '项目指令'}</Field>
        {item.reason && <Field label="理由">{item.reason}</Field>}
      </Fields>
      <Separator />
      <Markdown>{item.content}</Markdown>
    </div>
  );
}
