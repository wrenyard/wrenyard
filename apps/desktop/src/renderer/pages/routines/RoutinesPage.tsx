import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { Page, PageContent, PageHeader, PageTitle } from '@/renderer/components/page';
import { QueryError } from '@/renderer/components/query-error';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/renderer/components/ui/empty';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/renderer/components/ui/input-group';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import type { AgentBot } from '@/shell-contract';
import { useAgentsQuery, useRoutinesQuery } from '../agents/queries.js';
import { RoutinesSection } from './RoutinesSection.js';

/**
 * One bot's routines, surfaced only when it matches the current search. The bot
 * matches if its name matches or any of its routine prompts matches; the section
 * then keeps its own prompt filter on the table. Reports its match back so the
 * page can show the empty-search state once every bot has reported.
 */
function RoutinesBotEntry(props: {
  bot: AgentBot;
  filter: string;
  onMatchChange: (botId: string, matched: boolean) => void;
}) {
  const routines = useRoutinesQuery(props.bot.id);
  const key = props.filter.trim().toLowerCase();
  const matched = useMemo(() => {
    if (key === '') return true;
    if (props.bot.name.trim().toLowerCase().includes(key)) return true;
    return (routines.data?.routines ?? []).some((item) => item.prompt.toLowerCase().includes(key));
  }, [key, props.bot.name, routines.data]);

  useEffect(() => {
    props.onMatchChange(props.bot.id, matched);
    return () => { props.onMatchChange(props.bot.id, false); };
  }, [props.bot.id, props.onMatchChange, matched]);

  if (!matched) return null;
  return <RoutinesSection botId={props.bot.id} botName={props.bot.name} filter={props.filter} />;
}

/**
 * The 自动化 page: a standalone top search box (not the conversation search)
 * that filters the routines of every bot. Each bot renders its own routines
 * section; the daemon still owns routine state and config.
 */
export function RoutinesPage() {
  const agents = useAgentsQuery();
  const [search, setSearch] = useState('');

  const bots = useMemo(() => agents.data?.bots ?? [], [agents.data]);
  const key = search.trim().toLowerCase();

  const matchedIds = useRef<Set<string>>(new Set());
  const [, retick] = useReducer((count: number) => count + 1, 0);
  const onMatchChange = useCallback((botId: string, matched: boolean) => {
    const had = matchedIds.current.has(botId);
    if (had === matched) return;
    if (matched) matchedIds.current.add(botId);
    else matchedIds.current.delete(botId);
    retick();
  }, []);

  // Drop match records for bots that are no longer present.
  useEffect(() => {
    const present = new Set(bots.map((bot) => bot.id));
    let changed = false;
    for (const id of matchedIds.current) {
      if (!present.has(id)) {
        matchedIds.current.delete(id);
        changed = true;
      }
    }
    if (changed) retick();
  }, [bots]);

  if (agents.isError) return <QueryError query={agents} title="自动化" />;
  if (agents.isPending) {
    return (
      <Page data-page="routines">
        <PageHeader>
          <PageTitle>自动化</PageTitle>
        </PageHeader>
        <PageContent className="gap-4 p-4">
          <Skeleton className="h-9 w-full max-w-sm" />
          <Skeleton className="h-40 w-full" />
        </PageContent>
      </Page>
    );
  }

  const noBots = bots.length === 0;
  const noMatch = key !== '' && !noBots && matchedIds.current.size === 0;

  return (
    <Page data-page="routines">
      <PageHeader>
        <PageTitle>自动化</PageTitle>
      </PageHeader>
      <PageContent className="gap-4 p-4">
        <InputGroup className="max-w-sm">
          <InputGroupAddon>
            <Search className="size-4" />
          </InputGroupAddon>
          <InputGroupInput
            value={search}
            placeholder="搜索例行任务"
            aria-label="搜索例行任务"
            onChange={(event) => setSearch(event.target.value)}
          />
        </InputGroup>
        {noBots ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>暂无机器人</EmptyTitle>
              <EmptyDescription>先创建一个机器人，再为它添加例行任务。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : noMatch ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>没有匹配的例行任务</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          bots.map((bot) => (
            <RoutinesBotEntry key={bot.id} bot={bot} filter={search} onMatchChange={onMatchChange} />
          ))
        )}
      </PageContent>
    </Page>
  );
}
