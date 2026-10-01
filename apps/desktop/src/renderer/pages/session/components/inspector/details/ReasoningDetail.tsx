import { Markdown } from '@/renderer/components/markdown';
import { Item, ItemContent } from '@/renderer/components/ui/item';
import type { InspectorTarget, ReasoningModel } from '../../../model/types.js';
import { Field, Fields, InspectLink, Section } from '../parts.js';

/** Visible reasoning output plus its optional thinking trace. */
export function ReasoningDetail({ reasoning, onSelect }: { reasoning: ReasoningModel; onSelect: (target: InspectorTarget) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <Fields>
        <Field label="调用">
          <InspectLink onClick={() => onSelect({ kind: 'call', callId: reasoning.callId })}>
            {reasoning.callId}
          </InspectLink>
        </Field>
      </Fields>
      <Section title="可见输出"><Markdown>{reasoning.text}</Markdown></Section>
      {reasoning.thinking && (
        <Section title="Thinking">
          <Item variant="muted">
            <ItemContent>
              <pre className="overflow-x-auto whitespace-pre-wrap">{reasoning.thinking}</pre>
            </ItemContent>
          </Item>
        </Section>
      )}
    </div>
  );
}
