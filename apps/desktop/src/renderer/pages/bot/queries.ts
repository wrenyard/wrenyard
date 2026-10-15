import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BotControlAction, BotItemAction, BotLogRecord, BotMode } from '@/shell-contract';
import { botRequest, useRemoteConnection } from '@/renderer/lib/desktop';

/**
 * Bot projections are only meaningful while an endpoint is committed: a switch
 * in progress or a lost remote tunnel would otherwise poll the wrong daemon.
 */
function useBotEnabled(): boolean {
  const connection = useRemoteConnection();
  return connection.state === 'local' || connection.state === 'remote';
}

/** Cache keys for the bot projections; the mutations invalidate these. */
export const botKeys = {
  list: ['bot', 'list'] as const,
  items: (botId: string) => ['bot', 'items', botId] as const,
  health: (botId: string) => ['bot', 'health', botId] as const,
  log: (botId: string) => ['bot', 'log', botId] as const,
};

/** Largest number of log lines the page keeps in memory. */
const LOG_LIMIT = 500;

/** Polled bot list; the daemon owns creation, persistence and ticking. */
export function useBotsQuery() {
  const enabled = useBotEnabled();
  return useQuery({
    queryKey: botKeys.list,
    queryFn: () => botRequest('bot.list'),
    refetchInterval: 5000,
    enabled,
  });
}

/** Polled pipeline of one bot. An absent botId keeps the query idle. */
export function useBotItemsQuery(botId: string | null) {
  const enabled = useBotEnabled();
  return useQuery({
    queryKey: botKeys.items(botId ?? ''),
    queryFn: async () => {
      if (botId === null) return { items: [] };
      return botRequest('bot.items', { botId });
    },
    refetchInterval: 5000,
    enabled: enabled && botId !== null,
  });
}

/** Polled endurance counters and host identity of one bot. */
export function useBotHealthQuery(botId: string | null) {
  const enabled = useBotEnabled();
  return useQuery({
    queryKey: botKeys.health(botId ?? ''),
    queryFn: async () => {
      if (botId === null) return null;
      return botRequest('bot.health', { botId });
    },
    refetchInterval: 5000,
    enabled: enabled && botId !== null,
  });
}

/**
 * Incremental log tail: each poll asks only for entries after the highest seq
 * already seen, and the accumulator keeps the last {@link LOG_LIMIT} lines.
 */
export function useBotLogQuery(botId: string | null) {
  const enabled = useBotEnabled();
  // The cursor lives outside the query cache so switching bots restarts clean.
  const cursor = useRef(0);
  const [entries, setEntries] = useState<BotLogRecord[]>([]);

  useEffect(() => {
    cursor.current = 0;
    setEntries([]);
  }, [botId]);

  const query = useQuery({
    queryKey: botKeys.log(botId ?? ''),
    refetchInterval: 3000,
    enabled: enabled && botId !== null,
    queryFn: async () => {
      if (botId === null) return { entries: [] };
      const result = await botRequest('bot.log', { botId, afterSeq: cursor.current });
      const last = result.entries.at(-1);
      if (last !== undefined) {
        cursor.current = last.seq;
        setEntries((previous) => [...previous, ...result.entries].slice(-LOG_LIMIT));
      }
      return result;
    },
  });

  return { query, entries };
}

/** Create one bot bound to a user-local config file. */
export function useBotCreateMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; configPath: string; mode?: BotMode }) =>
      botRequest('bot.create', input),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: botKeys.list }); },
  });
}

/** Start, pause, resume or stop one bot. */
export function useBotControlMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { botId: string; action: BotControlAction }) =>
      botRequest('bot.control', input),
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({ queryKey: botKeys.list });
      void queryClient.invalidateQueries({ queryKey: botKeys.items(input.botId) });
      void queryClient.invalidateQueries({ queryKey: botKeys.health(input.botId) });
    },
  });
}

/** Run one bot tick now instead of waiting for the cadence. */
export function useBotTickMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (botId: string) => botRequest('bot.tick', { botId }),
    onSuccess: (_result, botId) => {
      void queryClient.invalidateQueries({ queryKey: botKeys.list });
      void queryClient.invalidateQueries({ queryKey: botKeys.items(botId) });
      void queryClient.invalidateQueries({ queryKey: botKeys.health(botId) });
      void queryClient.invalidateQueries({ queryKey: botKeys.log(botId) });
    },
  });
}

/** Answer, dismiss, retry or clean up one item. */
export function useBotItemActionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { botId: string; itemId: string; action: BotItemAction; answer?: string }) =>
      botRequest('bot.item.action', input),
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({ queryKey: botKeys.items(input.botId) });
      void queryClient.invalidateQueries({ queryKey: botKeys.log(input.botId) });
    },
  });
}

/** Validate one candidate config file before creating a bot. */
export function useBotConfigValidateMutation() {
  return useMutation({
    mutationFn: (configPath: string) => botRequest('bot.config.validate', { configPath }),
  });
}
