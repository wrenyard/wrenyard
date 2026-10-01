import { useMemo, useState } from 'react';
import { JsonView } from '@/renderer/components/json-view';
import { Markdown } from '@/renderer/components/markdown';
import { ToggleGroup, ToggleGroupItem } from '@/renderer/components/ui/toggle-group';
import type { TaskSettingsInstructionTemplate } from '@/shell-contract';
import { PREVIEW_EMPTY, PREVIEW_TAB_JSON, PREVIEW_TAB_PREVIEW } from '../model/describe.js';

type PreviewView = 'preview' | 'json';

/**
 * Flattens the structured instruction template into one markdown string: static
 * text is carried verbatim and each placeholder becomes an inline code token.
 * Nothing is executed here and no runtime prompt is generated.
 */
function flattenTemplate(template: TaskSettingsInstructionTemplate): string {
  return template
    .map((segment) => (segment.kind === 'text' ? segment.text : `\`${segment.label}\``))
    .join('');
}

/** Read-only static instruction-template preview from the daemon DTO. */
export function TemplatePreview({ template }: { template: TaskSettingsInstructionTemplate }) {
  const [view, setView] = useState<PreviewView>('preview');
  const markdown = useMemo(() => flattenTemplate(template), [template]);

  if (template.length === 0) {
    return <p className="text-muted-foreground">{PREVIEW_EMPTY}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <ToggleGroup
        variant="outline"
       
        value={[view]}
        onValueChange={(value) => {
          const next = value[0];
          if (next === 'preview' || next === 'json') setView(next);
        }}
      >
        <ToggleGroupItem value="preview">{PREVIEW_TAB_PREVIEW}</ToggleGroupItem>
        <ToggleGroupItem value="json">{PREVIEW_TAB_JSON}</ToggleGroupItem>
      </ToggleGroup>
      {view === 'preview'
        ? <Markdown>{markdown}</Markdown>
        : <JsonView value={template} />}
    </div>
  );
}
