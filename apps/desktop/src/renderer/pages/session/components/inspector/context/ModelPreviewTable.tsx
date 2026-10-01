import { useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from 'cn';
import { BrandIcon } from '@/renderer/components/brand-icon';
import { Badge } from '@/renderer/components/ui/badge';
import { Button } from '@/renderer/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/renderer/components/ui/collapsible';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/renderer/components/ui/table';
import { UsageRing } from '@/renderer/components/usage/UsageRing';
import { formatCost, formatRatio, formatTokenCount } from '@/renderer/lib/format';
import { providerBrand } from '@/renderer/lib/model-brand';
import type { QuotaSnapshot } from '@/shell-contract';
import { modelPreviews } from '../../../model/usage.js';
import type { ModelEntry } from '../../../model/types.js';
import { Section } from '../parts.js';

export interface ModelPreviewTableProps {
  models: readonly ModelEntry[];
  modelId: string;
  totalTokens: number;
  cacheRatio: number | undefined;
  quota: QuotaSnapshot | undefined;
  onUseModel: (modelId: string) => void;
}

/**
 * Switching-model preview. Only models with a known context window get a table
 * row (the current model first); models whose window is unknown are collapsed
 * into one summary row so the table never fills with 未知 rows.
 */
export function ModelPreviewTable({ models, modelId, totalTokens, cacheRatio, quota, onUseModel }: ModelPreviewTableProps) {
  const [open, setOpen] = useState(false);
  const { known, unknown } = useMemo(() => {
    const withWindow = models.filter((entry) => entry.contextWindow !== undefined);
    const withoutWindow = models.filter((entry) => entry.contextWindow === undefined);
    withWindow.sort((left, right) => (left.publicId === modelId ? 0 : 1) - (right.publicId === modelId ? 0 : 1));
    return { known: withWindow, unknown: withoutWindow };
  }, [models, modelId]);

  if (models.length === 0) return <p className="text-sm text-muted-foreground">还没有可用的模型</p>;

  return (
    <Section title="换模型预演">
      {known.length === 0 ? (
        <p className="text-sm text-muted-foreground">还没有窗口已知的模型</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>模型</TableHead>
              <TableHead className="text-right">窗口</TableHead>
              <TableHead className="text-right">可用</TableHead>
              <TableHead className="text-right">占用</TableHead>
              <TableHead className="text-right">单次推理输入费用</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {known.map((entry) => {
              const preview = modelPreviews([entry], totalTokens, cacheRatio, quota)[0]!;
              const { available, ratio } = preview;
              const current = entry.publicId === modelId;
              return (
                <TableRow key={entry.publicId}>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      <BrandIcon brand={providerBrand(entry.provider)} size={16} />
                      <span className="truncate">{entry.displayName}</span>
                      {current && <Badge variant="secondary">当前</Badge>}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatTokenCount(entry.contextWindow)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatTokenCount(available)}</TableCell>
                  <TableCell>
                    <span className="flex items-center justify-end gap-1.5 tabular-nums">
                      <UsageRing ratio={ratio} status={ratio === undefined ? 'unknown' : 'ready'} />
                      {formatRatio(ratio)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatCost(preview.inputCost)}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={current}
                      onClick={() => onUseModel(entry.publicId)}
                    >
                      使用此模型
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      {unknown.length > 0 && (
        <Collapsible open={open} onOpenChange={setOpen} className="mt-2 flex flex-col gap-1">
          <CollapsibleTrigger className="flex w-fit cursor-pointer items-center gap-1 text-sm text-muted-foreground">
            <ChevronRight className={cn('size-4 transition-transform', open && 'rotate-90')} />
            {`其余 ${unknown.length} 个模型窗口未知`}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {unknown.map((entry) => <span key={entry.publicId}>{entry.displayName}</span>)}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </Section>
  );
}
