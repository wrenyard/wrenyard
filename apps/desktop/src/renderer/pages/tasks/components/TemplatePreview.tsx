import { useMemo, useState } from 'react';
import { Maximize2 } from 'lucide-react';
import { cn } from 'cn';
import { DIALOG_BODY_CLASS, DIALOG_CONTENT_CLASS } from '@/renderer/components/dialog-size';
import { AppMarkdown as Markdown } from '@/renderer/components/app-markdown';
import { Button } from '@/renderer/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/renderer/components/ui/dialog';
import { ToggleGroup, ToggleGroupItem } from '@/renderer/components/ui/toggle-group';
import type { TaskSettingsInstructionTemplate } from '@/shell-contract';
import {
  PREVIEW_EMPTY,
  PREVIEW_EXPAND_LABEL,
  PREVIEW_TAB_JSON,
  PREVIEW_TAB_PREVIEW,
  PREVIEW_TITLE,
} from '../model/describe.js';

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

/** Template prose stays at body size: headings are scaled down so one long template cannot dominate the page. */
const PROSE_CLASS = 'min-w-0 break-words text-sm [&_h1]:mt-0 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:text-sm';

/**
 * One highlighted `json` fence for the whole template. Streamdown's code body
 * draws its own `overflow-x-auto` box and the inner `<pre>` keeps `white-space:
 * pre`, so a long JSON line would clip and each block would grow its own
 * horizontal scrollbar. These arbitrary selectors disable that scrollbar and
 * wrap the pre/code/span content instead.
 */
const JSON_CLASS = 'min-w-0 text-sm [&_pre]:whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere] [&_pre_code]:whitespace-pre-wrap [&_pre_span]:whitespace-pre-wrap [&_[data-streamdown=code-block-body]]:overflow-x-hidden [&_[data-streamdown=code-block-body]]:max-h-none! [&_[data-streamdown=code-block-body]]:overflow-y-visible';

function PreviewBody({ view, template, markdown }: { view: PreviewView; template: TaskSettingsInstructionTemplate; markdown: string }) {
  return view === 'preview'
    ? <div className={PROSE_CLASS}><Markdown>{markdown}</Markdown></div>
    : <div className={JSON_CLASS}><Markdown>{'```json\n' + JSON.stringify(template, null, 2) + '\n```'}</Markdown></div>;
}

/**
 * Read-only static instruction-template preview from the daemon DTO. The panel
 * fills the height its parent gives it and scrolls internally; the expand
 * button opens the same view in a large dialog.
 */
export function TemplatePreview({ template, className }: { template: TaskSettingsInstructionTemplate; className?: string }) {
  const [view, setView] = useState<PreviewView>('preview');
  const [expanded, setExpanded] = useState(false);
  const markdown = useMemo(() => flattenTemplate(template), [template]);
  const empty = template.length === 0;

  const toggle = (
    <ToggleGroup
      variant="outline"
      size="sm"
      value={[view]}
      onValueChange={(value) => {
        const next = value[0];
        if (next === 'preview' || next === 'json') setView(next);
      }}
    >
      <ToggleGroupItem value="preview">{PREVIEW_TAB_PREVIEW}</ToggleGroupItem>
      <ToggleGroupItem value="json">{PREVIEW_TAB_JSON}</ToggleGroupItem>
    </ToggleGroup>
  );

  return (
    <section className={cn('flex min-h-0 flex-col overflow-hidden rounded-lg border', className)}>
      <div className="flex shrink-0 items-center gap-2 border-b bg-muted/30 px-3 py-2">
        <h3 className="mr-auto truncate text-sm font-medium">{PREVIEW_TITLE}</h3>
        {empty ? null : (
          <>
            {toggle}
            <Button variant="ghost" size="icon-sm" title={PREVIEW_EXPAND_LABEL} aria-label={PREVIEW_EXPAND_LABEL} onClick={() => setExpanded(true)}>
              <Maximize2 />
            </Button>
          </>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {empty
          ? <p className="text-muted-foreground">{PREVIEW_EMPTY}</p>
          : <PreviewBody view={view} template={template} markdown={markdown} />}
      </div>
      {empty ? null : (
        <Dialog open={expanded} onOpenChange={(open) => setExpanded(open)}>
          <DialogContent className={cn('sm:max-w-[min(960px,calc(100vw-4rem))]', DIALOG_CONTENT_CLASS)}>
            <DialogHeader className="flex-row items-center gap-3 pr-8">
              <DialogTitle className="mr-auto">{PREVIEW_TITLE}</DialogTitle>
              {toggle}
            </DialogHeader>
            <div className={cn(DIALOG_BODY_CLASS, 'h-[70dvh]')}>
              <PreviewBody view={view} template={template} markdown={markdown} />
            </div>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}
