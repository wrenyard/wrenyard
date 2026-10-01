import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from 'recharts';
import type { ContextInspection, ContextItem as InspectionItem, ContextItemKind, ContextLayerId } from '@wrenyard/session';
import { BrandIcon } from '@/renderer/components/brand-icon';
import { QueryError } from '@/renderer/components/query-error';
import { Alert, AlertDescription, AlertTitle } from '@/renderer/components/ui/alert';
import { Badge } from '@/renderer/components/ui/badge';
import { Button } from '@/renderer/components/ui/button';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/renderer/components/ui/chart';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/components/ui/select';
import { Spinner } from '@/renderer/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/renderer/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/renderer/components/ui/toggle-group';
import { useQuotaQuery } from '@/renderer/lib/queries';
import { TokenBar } from '@/renderer/components/usage/TokenBar';
import { UsageRing } from '@/renderer/components/usage/UsageRing';
import { formatTokenCount } from '@/renderer/lib/format';
import { providerBrand } from '@/renderer/lib/model-brand';
import type { QuotaSnapshot } from '@/shell-contract';
import { contextQuery, useThrottledSeq } from '../../queries.js';
import { CALL_ROLE_LABEL } from '../../model/describe.js';
import { callCost, contextBudget, growthByTurn, recentCacheRatio, usageGroups, modelPreviews, remainingTurns, countInputTokens } from '../../model/usage.js';
import type { CallModel, ModelEntry, SessionModel } from '../../model/types.js';
import { requestContextInspection, requestSessionModel, useSessionUsage } from '../../state/usage-selection.js';
import { Section } from './parts.js';

/**
 * Inspector "上下文" tab: the whole-session audit surface from the usage-meter
 * spec (§7). It reads the shared selected model from the usage-selection bridge,
 * loads the read-only context inspection through `api.contextInspect`, and uses
 * the shared T13 `model/usage.ts` helpers for every token/fee calculation. All
 * calculations stay in that module; this file only renders.
 */

type Budget = ReturnType<typeof contextBudget>;
type UsageGroup = ReturnType<typeof usageGroups>[number];
type GrowthPoint = ReturnType<typeof growthByTurn>[number];

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

function formatShare(tokens: number, total: number): string {
  if (total <= 0) return '—';
  return `${Math.round((tokens / total) * 100)}%`;
}

function formatRatio(ratio: number | undefined): string {
  if (ratio === undefined || !Number.isFinite(ratio)) return '—';
  return `${Math.round(ratio * 100)}%`;
}

/** Fee column: unknown prices must read as an em dash, never as zero. */
function formatCost(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  if (value === 0) return '$0';
  return `$${value.toFixed(4)}`;
}

function formatWindow(value: number | undefined): string {
  return value === undefined ? '未知' : formatTokenCount(value);
}

/* ------------------------------------------------------------------ */
/* Composition groups (spec §5.2): group → event type → item           */
/* ------------------------------------------------------------------ */

type UsageGroupId = 'resident' | 'workspace' | 'conversation' | 'materials' | 'results' | 'info';

const GROUP_ORDER: readonly UsageGroupId[] = ['resident', 'workspace', 'conversation', 'materials', 'results', 'info'];

const GROUP_LABEL: Record<UsageGroupId, string> = {
  resident: '常驻',
  workspace: '工作区快照',
  conversation: '对话',
  materials: '资料',
  results: '任务结果',
  info: '运行信息',
};

const ITEM_GROUPS: readonly UsageGroupId[] = ['conversation', 'materials', 'results'];

const KIND_GROUP: Record<ContextItemKind, UsageGroupId> = {
  user: 'conversation',
  assistant: 'conversation',
  reply: 'conversation',
  interrupt: 'conversation',
  doc: 'materials',
  memory: 'materials',
  'action-result': 'results',
  'ws-update': 'results',
};

const LAYER_GROUP: Record<ContextLayerId, UsageGroupId> = {
  'wy-system': 'resident',
  'wy-global': 'resident',
  'wy-role': 'resident',
  'wy-workspace': 'workspace',
  'wy-ctx': 'conversation',
  'wy-info': 'info',
};

const KIND_LABEL: Record<ContextItemKind, string> = {
  user: '用户消息',
  assistant: '助手消息',
  reply: '回复',
  doc: '文档',
  memory: '记忆',
  'action-result': '行动结果',
  'ws-update': '工作区更新',
  interrupt: '中断',
};

type TreeRow =
  | { key: string; kind: 'group'; group: UsageGroupId; label: string; tokens: number }
  | { key: string; kind: 'type'; group: UsageGroupId; typeKey: string; label: string; tokens: number }
  | { key: string; kind: 'item'; group: UsageGroupId; item: InspectionItem };

const TREE_GRID = 'grid grid-cols-[minmax(0,1fr)_3.5rem_4rem_5rem_4.5rem_3.5rem] items-center gap-x-2';

function sumTokens(values: readonly { tokens: number }[]): number {
  let total = 0;
  for (const value of values) total += value.tokens;
  return total;
}

function groupItemsByKind(items: readonly InspectionItem[]): Map<ContextItemKind, InspectionItem[]> {
  const grouped = new Map<ContextItemKind, InspectionItem[]>();
  for (const item of items) {
    const list = grouped.get(item.kind);
    if (list) list.push(item);
    else grouped.set(item.kind, [item]);
  }
  return grouped;
}

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

function remainingRounds(growth: readonly GrowthPoint[], budget: Budget): { rounds: number; warn: boolean } | null {
  if (budget.available === undefined) return null;
  const remaining = remainingTurns(growth, budget.available - budget.total);
  return remaining ? { rounds: remaining.turns, warn: remaining.warn } : null;
}

function CompositionBar({ groups, budget }: { groups: readonly UsageGroup[]; budget: Budget }) {
  return <TokenBar segments={groups} window={budget.window} reserved={budget.reserved} />;
}

function OverviewCard({ inspection, budget, groups, growth, cacheRatio }: {
  inspection: ContextInspection;
  budget: Budget;
  groups: readonly UsageGroup[];
  growth: readonly GrowthPoint[];
  cacheRatio: number | undefined;
}) {
  const rounds = remainingRounds(growth, budget);
  const calibration = inspection.calibration?.model === inspection.model.publicId ? inspection.calibration : undefined;
  const factor = calibration && calibration.estimated > 0 ? calibration.actual / calibration.estimated : undefined;

  return (
    <Section title="上下文">
      <div className="flex flex-col gap-3">
        {budget.exceeded && (
          <Alert variant="destructive">
            <AlertTitle>上下文已超出当前模型的可用窗口</AlertTitle>
            <AlertDescription>
              {`${inspection.model.publicId} 可用 ${formatTokenCount(budget.available)}，当前约 ${formatTokenCount(budget.total)}。`}
            </AlertDescription>
          </Alert>
        )}
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-2xl font-medium tabular-nums">{formatRatio(budget.ratio)}</span>
          <span className="text-sm text-muted-foreground">
            {`约 ${formatTokenCount(budget.total)} / ${formatTokenCount(budget.available)} 可用`}
            {budget.reserved !== undefined && ` · 预留输出 ${formatTokenCount(budget.reserved)}`}
          </span>
        </div>
        <CompositionBar groups={groups} budget={budget} />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>{`下次推理 · ${inspection.model.publicId}`}</span>
          {calibration && factor !== undefined && (
            <span>{`按上次实际用量校准约 ${formatTokenCount(budget.total * factor)}（×${factor.toFixed(2)}）`}</span>
          )}
          <span className={cacheRatio !== undefined && cacheRatio < 0.5 ? 'text-warning' : undefined}>
            {cacheRatio === undefined ? '缓存命中 —' : `缓存命中 ${Math.round(cacheRatio * 100)}%`}
          </span>
          {rounds && (
            <span className={rounds.warn ? 'text-warning' : undefined}>
              {rounds.rounds > 0 ? `按近 ${Math.min(growth.length, 5)} 轮约还能 ${rounds.rounds} 轮` : '上下文已满，无法继续'}
            </span>
          )}
        </div>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Model preview (spec §7 换模型预演)                                   */
/* ------------------------------------------------------------------ */

function ModelPreviewTable({ models, modelId, totalTokens, cacheRatio, quota }: {
  models: readonly ModelEntry[];
  modelId: string;
  totalTokens: number;
  cacheRatio: number | undefined;
  quota: QuotaSnapshot | undefined;
}) {
  const rows = useMemo(() => {
    const ordered = [...models];
    ordered.sort((left, right) => {
      const leftCurrent = left.publicId === modelId ? 0 : 1;
      const rightCurrent = right.publicId === modelId ? 0 : 1;
      return leftCurrent - rightCurrent;
    });
    return ordered;
  }, [models, modelId]);

  if (rows.length === 0) return <p className="text-sm text-muted-foreground">还没有可用的模型</p>;

  return (
    <Section title="换模型预演">
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
          {rows.map((entry) => {
            const preview = modelPreviews([entry], totalTokens, cacheRatio, quota)[0]!;
            const { available, ratio } = preview;
            const cost = preview.inputCost;
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
                <TableCell className="text-right tabular-nums">{formatWindow(entry.contextWindow)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatTokenCount(available)}</TableCell>
                <TableCell>
                  <span className="flex items-center justify-end gap-1.5 tabular-nums">
                    <UsageRing ratio={ratio} status={ratio === undefined ? 'unknown' : 'ready'} />
                    {formatRatio(ratio)}
                  </span>
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatCost(cost)}</TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={current}
                    onClick={() => requestSessionModel(entry.publicId)}
                  >
                    使用此模型
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Composition tree (spec §7 构成)                                      */
/* ------------------------------------------------------------------ */

type TreeSort = 'seq' | 'tokens';

function ContextTree({ items, layers, total, sessionKey }: {
  items: readonly InspectionItem[];
  layers: readonly { id: ContextLayerId; tokens: number }[];
  total: number;
  sessionKey: string;
}) {
  const [turn, setTurn] = useState('all');
  const [kinds, setKinds] = useState<ContextItemKind[]>([]);
  const [sort, setSort] = useState<TreeSort>('tokens');
  const [expandedGroups, setExpandedGroups] = useState<Set<UsageGroupId>>(() => new Set(GROUP_ORDER));
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(new Set());
  const parentRef = useRef<HTMLDivElement>(null);

  const turnIds = useMemo(
    () => [...new Set(items.map((item) => item.turn))].sort((left, right) => left - right),
    [items],
  );
  const allKinds = useMemo(() => [...new Set(items.map((item) => item.kind))], [items]);

  const visibleItems = useMemo(() => {
    let list = items.slice();
    if (turn !== 'all') list = list.filter((item) => String(item.turn) === turn);
    if (kinds.length > 0) list = list.filter((item) => kinds.includes(item.kind));
    list.sort(sort === 'tokens'
      ? (left, right) => right.tokens - left.tokens || left.seq - right.seq
      : (left, right) => left.seq - right.seq);
    return list;
  }, [items, turn, kinds, sort]);

  const rows = useMemo(() => {
    const out: TreeRow[] = [];
    const grouped = groupItemsByKind(visibleItems);
    for (const group of GROUP_ORDER) {
      if (ITEM_GROUPS.includes(group)) {
        const kindsInGroup = allKinds.filter((kind) => KIND_GROUP[kind] === group && grouped.has(kind));
        if (kindsInGroup.length === 0) continue;
        const groupItems: InspectionItem[] = [];
        for (const kind of kindsInGroup) groupItems.push(...(grouped.get(kind) ?? []));
        out.push({ key: `g:${group}`, kind: 'group', group, label: GROUP_LABEL[group], tokens: sumTokens(groupItems) });
        if (!expandedGroups.has(group)) continue;
        for (const kind of kindsInGroup) {
          const children = (grouped.get(kind) ?? []).slice().sort(
            sort === 'seq' ? (left, right) => left.seq - right.seq : (left, right) => right.tokens - left.tokens || left.seq - right.seq,
          );
          out.push({ key: `t:${group}:${kind}`, kind: 'type', group, typeKey: kind, label: KIND_LABEL[kind], tokens: sumTokens(children) });
          if (!expandedTypes.has(`${group}/${kind}`)) continue;
          for (const item of children) out.push({ key: `i:${item.seq}`, kind: 'item', group, item });
        }
        continue;
      }
      const groupLayers = layers.filter((layer) => LAYER_GROUP[layer.id] === group && layer.id !== 'wy-ctx');
      if (groupLayers.length === 0) continue;
      out.push({ key: `g:${group}`, kind: 'group', group, label: GROUP_LABEL[group], tokens: sumTokens(groupLayers) });
      if (!expandedGroups.has(group)) continue;
      for (const layer of groupLayers) {
        out.push({ key: `l:${layer.id}`, kind: 'type', group, typeKey: layer.id, label: layer.id, tokens: layer.tokens });
      }
    }
    return out;
  }, [visibleItems, allKinds, layers, expandedGroups, expandedTypes, sort]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 36,
    overscan: 10,
    getItemKey: (index) => rows[index]!.key,
  });

  const toggleGroup = (group: UsageGroupId): void => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  const toggleType = (key: string): void => {
    setExpandedTypes((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <Section title="构成">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={turn} onValueChange={(value) => setTurn(String(value))}>
            <SelectTrigger className="w-28" aria-label="按轮次筛选">
              <SelectValue>{(value) => (value === 'all' ? '全部轮次' : `轮次 ${value}`)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部轮次</SelectItem>
              {turnIds.map((id) => <SelectItem key={id} value={String(id)}>{`轮次 ${id}`}</SelectItem>)}
            </SelectContent>
          </Select>
          <ToggleGroup multiple value={kinds} onValueChange={(value) => setKinds(value as ContextItemKind[])} variant="outline" size="sm" className="flex-wrap">
            {allKinds.map((kind) => (
              <ToggleGroupItem key={kind} value={kind}>{KIND_LABEL[kind]}</ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Select value={sort} onValueChange={(value) => setSort(value as TreeSort)}>
            <SelectTrigger className="ml-auto w-28" aria-label="排序方式">
              <SelectValue>{(value) => (value === 'seq' ? '按序号' : '按 Token')}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="seq">按序号</SelectItem>
              <SelectItem value="tokens">按 Token</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className={`${TREE_GRID} border-b pb-1 text-xs text-muted-foreground`}>
          <span>条目</span>
          <span className="text-right">序号</span>
          <span className="text-right">轮次</span>
          <span>类型</span>
          <span className="text-right">Token</span>
          <span className="text-right">占比</span>
        </div>
        <div ref={parentRef} className="max-h-80 min-h-0 overflow-auto">
          {rows.length === 0 && <p className="text-sm text-muted-foreground">没有匹配的条目</p>}
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index]!;
              return (
                <div
                  key={row.key}
                  className="absolute left-0 top-0 w-full"
                  style={{ height: virtualRow.size, transform: `translateY(${virtualRow.start}px)` }}
                >
                  <TreeRowView row={row} total={total} sessionKey={sessionKey} expandedGroups={expandedGroups} expandedTypes={expandedTypes} onToggleGroup={toggleGroup} onToggleType={toggleType} />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </Section>
  );
}

function TreeRowView({ row, total, sessionKey, expandedGroups, expandedTypes, onToggleGroup, onToggleType }: {
  row: TreeRow;
  total: number;
  sessionKey: string;
  expandedGroups: Set<UsageGroupId>;
  expandedTypes: Set<string>;
  onToggleGroup: (group: UsageGroupId) => void;
  onToggleType: (key: string) => void;
}) {
  if (row.kind === 'item') {
    return (
      <button
        type="button"
        className={`${TREE_GRID} h-9 w-full rounded-md px-1 text-left text-sm hover:bg-muted`}
        title={row.item.label}
        onClick={() => requestContextInspection(sessionKey, { tab: 'ledger', seq: row.item.seq })}
      >
        <span className="truncate pl-6">{row.item.label}</span>
        <span className="text-right tabular-nums">{row.item.seq}</span>
        <span className="text-right tabular-nums">{`T${row.item.turn}`}</span>
        <span className="truncate text-xs text-muted-foreground">{KIND_LABEL[row.item.kind]}</span>
        <span className="text-right tabular-nums">{formatTokenCount(row.item.tokens)}</span>
        <span className="text-right tabular-nums">{formatShare(row.item.tokens, total)}</span>
      </button>
    );
  }

  const expanded = row.kind === 'group' ? expandedGroups.has(row.group) : expandedTypes.has(`${row.group}/${row.typeKey}`);
  const indent = row.kind === 'group' ? '' : 'pl-4';
  const onToggle = (): void => {
    if (row.kind === 'group') onToggleGroup(row.group);
    else onToggleType(`${row.group}/${row.typeKey}`);
  };
  return (
    <button
      type="button"
      className={`${TREE_GRID} h-9 w-full rounded-md px-1 text-left text-sm hover:bg-muted`}
      aria-expanded={expanded}
      onClick={onToggle}
    >
      <span className={`flex min-w-0 items-center gap-1 font-medium ${indent}`}>
        {expanded ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
        <span className="truncate">{row.label}</span>
      </span>
      <span />
      <span />
      <span />
      <span className="text-right tabular-nums">{formatTokenCount(row.tokens)}</span>
      <span className="text-right tabular-nums">{formatShare(row.tokens, total)}</span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Growth area chart (spec §7 增长)                                     */
/* ------------------------------------------------------------------ */

const GROWTH_CONFIG: ChartConfig = {
  cumulative: { label: '累计占用', color: 'var(--chart-1)' },
};

function GrowthChart({ growth, budget }: { growth: readonly GrowthPoint[]; budget: Budget }) {
  if (growth.length === 0) return <p className="text-sm text-muted-foreground">还没有可用的轮次数据</p>;
  const baseline = Math.max(0, budget.total - sumTokens(growth));
  const data = [...growth].sort((left, right) => left.turn - right.turn).map((point) => ({ ...point, cumulative: baseline + point.cumulative }));
  const topCandidate = Math.max(...data.map((point) => point.cumulative), budget.available ?? 0, budget.window ?? 0);
  const top = topCandidate > 0 ? topCandidate : 1;

  return (
    <div className="flex flex-col gap-2">
      <ChartContainer config={GROWTH_CONFIG} className="aspect-auto h-48 w-full">
        <AreaChart data={data} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="turn" tickLine={false} axisLine={false} tickMargin={8} tickFormatter={(value: number) => `T${value}`} />
          <YAxis width={40} tickLine={false} axisLine={false} domain={[0, top]} tickFormatter={(value: number) => formatTokenCount(value)} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Area
            dataKey="cumulative"
            type="monotone"
            stroke="var(--color-cumulative)"
            fill="var(--color-cumulative)"
            fillOpacity={0.3}
          />
          {budget.available !== undefined && (
            <ReferenceLine y={budget.available} stroke="var(--destructive)" strokeDasharray="4 4" />
          )}
          {budget.window !== undefined && (
            <ReferenceLine y={budget.window} stroke="var(--muted-foreground)" strokeDasharray="2 2" />
          )}
        </AreaChart>
      </ChartContainer>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <span aria-hidden="true" className="h-0.5 w-4 bg-destructive" />
          可用窗口 · 预留输出起点
        </span>
        <span className="flex items-center gap-1">
          <span aria-hidden="true" className="h-0.5 w-4 bg-muted-foreground" />
          模型窗口
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Call summary (spec §7 调用)                                          */
/* ------------------------------------------------------------------ */

const ROLE_ORDER: readonly CallModel['role'][] = ['reason', 'select', 'interpret', 'compile', 'write', 'reply', 'title'];

interface RoleSummary {
  role: CallModel['role'];
  calls: CallModel[];
  ok: number;
  failed: number;
  aborted: number;
  input: number;
  cachedInput: number;
  output: number;
  reasoning: number;
  /** Undefined when any call's price is unknown; never a partial zero. */
  fee: number | undefined;
}

function summarizeRole(role: CallModel['role'], calls: readonly CallModel[], quota: QuotaSnapshot | undefined): RoleSummary {
  const summary: RoleSummary = {
    role,
    calls: [...calls],
    ok: 0,
    failed: 0,
    aborted: 0,
    input: 0,
    cachedInput: 0,
    output: 0,
    reasoning: 0,
    fee: quota === undefined ? undefined : 0,
  };
  for (const call of calls) {
    if (call.status === 'ok') summary.ok += 1;
    else if (call.status === 'failed') summary.failed += 1;
    else if (call.status === 'aborted') summary.aborted += 1;
    summary.input += call.usage?.input ?? 0;
    summary.cachedInput += call.usage?.cachedInput ?? 0;
    summary.output += call.usage?.output ?? 0;
    summary.reasoning += call.usage?.reasoning ?? 0;
    if (summary.fee !== undefined && quota !== undefined) {
      const cost = callCost(call, quota);
      if (cost === undefined) summary.fee = undefined;
      else summary.fee += cost;
    }
  }
  return summary;
}

function FeeTotal({ label, value }: { label: string; value: number | undefined }) {
  return <span>{`${label} ${formatCost(value)}`}</span>;
}

function CallSummary({ calls, quota }: { calls: readonly CallModel[]; quota: QuotaSnapshot | undefined }) {
  const [expanded, setExpanded] = useState(false);
  const summaries = useMemo(() => ROLE_ORDER
    .map((role) => summarizeRole(role, calls.filter((call) => call.role === role), quota))
    .filter((summary) => summary.calls.length > 0), [calls, quota]);

  if (summaries.length === 0) return <p className="text-sm text-muted-foreground">还没有模型调用</p>;

  const reason = summaries.find((summary) => summary.role === 'reason');
  const cheapSummaries = summaries.filter((summary) => summary.role !== 'reason');
  const cheapFee = cheapSummaries.some((summary) => summary.fee === undefined)
    ? undefined
    : cheapSummaries.reduce((sum, summary) => sum + (summary.fee ?? 0), 0);
  const reasonFee = reason ? reason.fee : 0;
  const totalFee = reasonFee !== undefined && cheapFee !== undefined ? reasonFee + cheapFee : undefined;

  return (
    <Section title="调用">
      <div className="flex flex-col gap-3">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>角色</TableHead>
              <TableHead className="text-right">成功 / 失败 / 中止</TableHead>
              <TableHead className="text-right">输入（缓存）</TableHead>
              <TableHead className="text-right">输出（推理）</TableHead>
              <TableHead className="text-right">缓存命中</TableHead>
              <TableHead className="text-right">费用</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {summaries.map((summary) => {
              const cacheHit = summary.input > 0 ? summary.cachedInput / summary.input : undefined;
              return (
                <TableRow key={summary.role}>
                  <TableCell>
                    {summary.role === 'reason' ? (
                      <button
                        type="button"
                        className="flex items-center gap-1 hover:text-foreground"
                        aria-expanded={expanded}
                        onClick={() => setExpanded((value) => !value)}
                      >
                        {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                        {CALL_ROLE_LABEL[summary.role]}
                      </button>
                    ) : CALL_ROLE_LABEL[summary.role]}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{`${summary.ok} / ${summary.failed} / ${summary.aborted}`}</TableCell>
                  <TableCell className="text-right tabular-nums">{`${summary.input.toLocaleString()}（${summary.cachedInput.toLocaleString()}）`}</TableCell>
                  <TableCell className="text-right tabular-nums">{`${summary.output.toLocaleString()}（${summary.reasoning.toLocaleString()}）`}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {cacheHit === undefined ? '—' : <span className={cacheHit < 0.5 ? 'text-warning' : undefined}>{`${Math.round(cacheHit * 100)}%`}</span>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatCost(summary.fee)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {expanded && reason && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>推理调用</TableHead>
                <TableHead>模型</TableHead>
                <TableHead className="text-right">估算</TableHead>
                <TableHead className="text-right">实际</TableHead>
                <TableHead className="text-right">估算 / 实际</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reason.calls.map((call) => {
                const actual = call.usage?.input;
                const estimated = call.estimatedInputTokens;
                const ratio = actual !== undefined && estimated !== undefined && estimated > 0 ? actual / estimated : undefined;
                return (
                  <TableRow key={call.id}>
                    <TableCell className="tabular-nums">{`T${call.turn}${call.cycle !== undefined ? ` · C${call.cycle}` : ''}`}</TableCell>
                    <TableCell className="truncate">{call.model}</TableCell>
                    <TableCell className="text-right tabular-nums">{estimated === undefined ? '—' : estimated.toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums">{actual === undefined ? '—' : actual.toLocaleString()}</TableCell>
                    <TableCell className={`text-right tabular-nums ${ratio !== undefined && ratio > 1.15 ? 'text-warning' : ''}`}>
                      {ratio === undefined ? '—' : `×${ratio.toFixed(2)}`}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <FeeTotal label="总费用" value={totalFee} />
          <FeeTotal label="昂贵调用" value={reasonFee} />
          <FeeTotal label="便宜调用" value={cheapFee} />
        </div>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Tab                                                                 */
/* ------------------------------------------------------------------ */

export interface ContextTabProps {
  model: SessionModel;
}

/** Whole-session context audit: overview, model preview, composition, growth and calls. */
export function ContextTab({ model }: ContextTabProps) {
  const { sessionKey, models, modelId, seq, inputText } = useSessionUsage();
  const inputTokens = useMemo(() => countInputTokens(inputText), [inputText]);
  const selected = models.find((entry) => entry.publicId === modelId);
  const throttledSeq = useThrottledSeq(seq);
  const inspection = useQuery(contextQuery(sessionKey, modelId, throttledSeq));
  const quota = useQuotaQuery();

  const data = inspection.data;
  const budget = useMemo(() => data ? contextBudget({ ...data, model: selected
    ? { publicId: selected.publicId, contextWindow: selected.contextWindow, maxOutputTokens: selected.maxOutputTokens }
    : data.model.publicId === modelId ? data.model : { publicId: modelId } }, inputTokens) : undefined,
    [data, selected, modelId, inputTokens]);
  const groups = useMemo(() => (data ? usageGroups(data, inputTokens) : []), [data, inputTokens]);
  const growth = useMemo(() => (data ? growthByTurn(data.items) : []), [data]);
  const cacheRatio = useMemo(() => recentCacheRatio(model.calls), [model.calls]);

  if (modelId === '') {
    return <p className="text-sm text-muted-foreground">请在输入框选择模型后查看上下文占用</p>;
  }
  if (inspection.isError) {
    return <QueryError query={inspection} title="无法读取上下文检查结果" />;
  }
  if (!data || !budget) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        正在计算上下文…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <OverviewCard inspection={data} budget={budget} groups={groups} growth={growth.filter((entry) => model.turns.some((turn) => turn.id === entry.turn && turn.status !== 'running'))} cacheRatio={cacheRatio} />
      <ModelPreviewTable
        models={models}
        modelId={modelId}
        totalTokens={budget.total}
        cacheRatio={cacheRatio}
        quota={quota.data}
      />
      <ContextTree items={data.items} layers={data.layers} total={data.totalTokens} sessionKey={sessionKey} />
      <Section title="增长">
        <GrowthChart growth={growth} budget={budget} />
      </Section>
      <CallSummary calls={model.calls} quota={quota.data} />
    </div>
  );
}
