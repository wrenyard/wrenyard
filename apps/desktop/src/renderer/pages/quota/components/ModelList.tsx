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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/renderer/components/ui/table';
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

/** Model table with family/text filters and a display-order switch. */
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
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
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
        <Input
          value={query}
          placeholder={MODEL_SEARCH_PLACEHOLDER}
          className="flex-1"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            {MODEL_COLUMNS.map((column) => (
              <TableHead
                key={column.id}
                className={cn(column.id === 'model' || column.id === 'providers' ? 'text-left' : 'text-right')}
              >
                {column.price ? `${column.label}${MODEL_PRICE_SUFFIX}` : column.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.length === 0 ? (
            <TableRow>
              <TableCell colSpan={MODEL_COLUMNS.length} className="text-muted-foreground">
                {MODELS_EMPTY}
              </TableCell>
            </TableRow>
          ) : (
            visible.map((row) => <ModelRow key={row.key} row={row} />)
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function ModelRow({ row }: { row: ModelListRow }) {
  return (
    <TableRow data-model={row.key}>
      <TableCell>
        <span className="inline-flex items-center gap-1.5">
          <BrandIcon brand={familyBrand(row.family)} />
          <span className={cn(!row.active && 'text-muted-foreground')}>{row.name}</span>
        </span>
      </TableCell>
      <TableCell className="text-right tabular-nums">{row.cacheLabel}</TableCell>
      <TableCell className="text-right tabular-nums">{row.inputLabel}</TableCell>
      <TableCell className="text-right tabular-nums">{row.outputLabel}</TableCell>
      <TableCell className="text-right tabular-nums">{formatTps(row.tps)}</TableCell>
      <TableCell>
        <span className="flex flex-wrap gap-1">
          {row.providers.map((provider) => (
            <Badge
              key={provider.id}
              variant="outline"
              className={cn('gap-1', !provider.available && 'text-muted-foreground')}
            >
              <BrandIcon brand={providerBrand(provider.id)} />
              {provider.label}
            </Badge>
          ))}
        </span>
      </TableCell>
    </TableRow>
  );
}
