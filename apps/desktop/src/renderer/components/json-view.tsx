import { Markdown } from '@/renderer/components/markdown';
import { cn } from 'cn';

function isComplex(value: unknown): boolean {
  return value !== null && typeof value === 'object';
}

function primitive(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  return String(value);
}

export interface JsonViewProps {
  value: unknown;
  className?: string;
}

/**
 * Renders a JSON value as a key/value list. Scalars stay inline; objects and
 * arrays fall back to a highlighted `json` code fence through Markdown.
 */
export function JsonView({ value, className }: JsonViewProps) {
  if (isComplex(value)) {
    const entries: [string, unknown][] = Array.isArray(value)
      ? value.map((item, index) => [String(index), item])
      : Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      return <span className={cn('text-muted-foreground', className)}>
        {Array.isArray(value) ? '[]' : '{}'}
      </span>;
    }
    return <dl className={cn('grid gap-2', className)}>
      {entries.map(([key, item]) => (
        <div key={key} className="grid grid-cols-[minmax(5rem,min-content)_1fr] items-start gap-3">
          <dt className="text-muted-foreground">{key}</dt>
          <dd className="min-w-0">{isComplex(item)
            ? <Markdown>{`\`\`\`json\n${JSON.stringify(item, null, 2)}\n\`\`\``}</Markdown>
            : <span>{primitive(item)}</span>}</dd>
        </div>
      ))}
    </dl>;
  }
  return <span className={cn(className)}>{primitive(value)}</span>;
}
