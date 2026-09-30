import { Markdown } from '@/renderer/components/markdown';
import type { InspectorTarget, ReasoningModel } from '../../../model/types.js';
import { Field, InspectLink, Section } from '../parts.js';

/** Visible reasoning output plus its optional thinking trace. */
export function ReasoningDetail({ reasoning, onSelect }: { reasoning: ReasoningModel; onSelect: (target: InspectorTarget) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <Field label="调用">
        <InspectLink onClick={() => onSelect({ kind: 'call', callId: reasoning.callId })}>
          {reasoning.callId}
        </InspectLink>
      </Field>
      <Section title="可见输出"><Markdown>{reasoning.text}</Markdown></Section>
      {reasoning.thinking && (
        <Section title="Thinking">
          <pre className="overflow-x-auto rounded-md bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap">{reasoning.thinking}</pre>
        </Section>
      )}
    </div>
  );
}
