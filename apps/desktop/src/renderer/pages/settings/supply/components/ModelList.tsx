import { useMemo, useState } from 'react';
import { BrandIcon } from '@/renderer/components/brand-icon';
import { Badge } from '@/renderer/components/ui/badge';
import { Input } from '@/renderer/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/renderer/components/ui/select';
import { familyBrand, providerBrand, type ModelFamily } from '@/renderer/lib/model-brand';
import { cn } from 'cn';
import {
  MODEL_COLUMNS,
  MODEL_FAMILY_FILTER_LABEL,
  MODEL_FILTER_ALL_LABEL,
  MODEL_PRICE_SUFFIX,
  MODEL_SEARCH_PLACEHOLDER,
  MODEL_SORT_LABEL,
  MODEL_SORT_OPTIONS,
  MODELS_EMPTY,
} from '../model/describe.js';
import {
  MODEL_FAMILY_ALL,
  filterModelRows,
  formatTps,
  modelFamilyOptions,
  sortModelRows,
  type ModelListRow,
  type ModelSort,
} from '../model/models.js';

/** Row metrics rendered as a definition grid, in heading order. */
const MODEL_METRIC_IDS = ['cache', 'input', 'output', 'tps'] as const;
type ModelMetricId = (typeof MODEL_METRIC_IDS)[number];

/** Heading copy for one metric, reusing the table labels and their price unit. */
function metricLabel(id: ModelMetricId): string {
  const column = MODEL_COLUMNS.find((candidate) => candidate.id === id);
  if (column === undefined) return id;
  return column.price ? `${column.label}${MODEL_PRICE_SUFFIX}` : column.label;
}

/**
 * Model list with family/text filters and a display-order switch. Each model is
 * one divided row: the wrapping model name beside its family icon, a definition
 * grid for prices and speed, and full-width provider entries below. The root is
 * a container, so the metric grid and the filter row follow the settings
 * content width instead of the window viewport.
 */
export function ModelList({ rows }: { rows: ModelListRow[] }) {
  const [family, setFamily] = useState<ModelFamily | typeof MODEL_FAMILY_ALL>(MODEL_FAMILY_ALL);
  const [sort, setSort] = useState<ModelSort>('default');
  const [query, setQuery] = useState('');

  const families = useMemo(() => modelFamilyOptions(rows), [rows]);
  const visible = useMemo(
    () => sortModelRows(filterModelRows(rows, family, query), sort),
    [rows, family, query, sort],
  );

  return (
    <div className="@container flex w-full max-w-full min-w-0 flex-col gap-4">
      <div className="flex min-w-0 flex-col gap-2 @lg:flex-row @lg:items-center">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Select value={family} onValueChange={(value) => setFamily(value as ModelFamily | typeof MODEL_FAMILY_ALL)}>
            <SelectTrigger aria-label={MODEL_FAMILY_FILTER_LABEL}>
              <SelectValue>
                {(value) => (value === MODEL_FAMILY_ALL ? MODEL_FILTER_ALL_LABEL : String(value))}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={MODEL_FAMILY_ALL}>{MODEL_FILTER_ALL_LABEL}</SelectItem>
              {families.map((option) => (
                <SelectItem key={option} value={option}>{option}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={sort} onValueChange={(value) => setSort(value as ModelSort)}>
            <SelectTrigger aria-label={MODEL_SORT_LABEL}>
              <SelectValue>
                {(value) => MODEL_SORT_OPTIONS.find((option) => option.value === value)?.label ?? ''}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {MODEL_SORT_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Input
          value={query}
          placeholder={MODEL_SEARCH_PLACEHOLDER}
          className="w-full min-w-0 @lg:flex-1"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <ul className="divide-y rounded-xl border bg-card">
        {visible.length === 0 ? (
          <li className="px-4 py-3 text-muted-foreground">{MODELS_EMPTY}</li>
        ) : (
          visible.map((row) => <ModelRow key={row.key} row={row} />)
        )}
      </ul>
    </div>
  );
}

function ModelRow({ row }: { row: ModelListRow }) {
  const values: Record<ModelMetricId, string> = {
    cache: row.cacheLabel,
    input: row.inputLabel,
    output: row.outputLabel,
    tps: formatTps(row.tps),
  };

  return (
    <li data-model={row.key} className="flex min-w-0 flex-col gap-3 px-4 py-3">
      <div className="flex min-w-0 items-start gap-2">
        <BrandIcon brand={familyBrand(row.family)} />
        <span className={cn('min-w-0 flex-1 [overflow-wrap:anywhere]', !row.active && 'text-muted-foreground')}>
          {row.name}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 @lg:grid-cols-4">
        {MODEL_METRIC_IDS.map((id) => (
          <div key={id} className="min-w-0">
            <dt className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{metricLabel(id)}</dt>
            <dd className="tabular-nums [overflow-wrap:anywhere]">{values[id]}</dd>
          </div>
        ))}
      </dl>
      <div className="flex min-w-0 flex-col gap-1">
        {row.providers.map((provider) => (
          <div key={provider.id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <Badge
              variant="outline"
              className={cn(
                'h-auto max-w-full min-w-0 shrink gap-1 overflow-visible whitespace-normal [overflow-wrap:anywhere]',
                !provider.available && 'text-muted-foreground',
              )}
            >
              <BrandIcon brand={providerBrand(provider.id)} />
              {provider.label}
            </Badge>
            {/* Secondary cost text beside the provider badge: the exact
                upstream credit multiplier, labelled with its offering name
                only when the provider declares several distinct ones. */}
            {provider.credits?.map((credit) => (
              <span
                key={credit.value}
                title="点数倍率"
                className="min-w-0 text-xs tabular-nums text-muted-foreground [overflow-wrap:anywhere]"
              >
                {credit.label === undefined ? credit.value : `${credit.label} ${credit.value}`}
              </span>
            ))}
          </div>
        ))}
      </div>
    </li>
  );
}
