/**
 * The side panel's 用量 tab (retire-status-bar spec): two stacked sections.
 * 本会话 shows the same context breakdown and session metrics as the session
 * page's status items, while a session is open; 额度 reuses the status-bar
 * quota panel with the selected model's provider first and a one-shot scroll
 * target the store supplies. A footer link reaches the 工房台账 stats page.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChartColumn } from 'lucide-react';
import { Separator } from '@/renderer/components/ui/separator';
import { PanelFooterAction } from '@/renderer/components/panel-footer-action';
import { consumeActivityPanelProvider } from '@/renderer/lib/activity-panel';
import { useActiveSession } from '@/renderer/lib/navigation';
import { shell } from '@/renderer/lib/desktop';
import { getSessionBridge } from '@/renderer/lib/session';
import { useQuotaFocus } from '@/renderer/lib/statusbar';
import type { LedgerEvent } from '@/renderer/pages/session/model/types';
import { fold } from '@/renderer/pages/session/model/fold';
import { SessionUsageProvider, useComposerSelection, useSessionUsage } from '@/renderer/pages/session/state/session-usage';
import { useSessionUsagePanelData, SessionUsagePanel } from '@/renderer/pages/session/components/status/SessionStatusItems';
import { ContextBreakdown } from '@/renderer/pages/session/components/usage/ContextBreakdown';
import { QuotaPanel } from '@/renderer/app/statusbar/QuotaPanel';

/** The models the usage panel resolves names and routes against. */
function useSessionModels() {
  return useQuery({
    queryKey: ['session', 'models', 'usage-panel'] as const,
    queryFn: () => getSessionBridge().models(),
    staleTime: 60_000,
  });
}

/**
 * Ledger events of one session for the panel: the snapshot read (which does
 * not disturb the page's own live subscription) plus pushed events, folded
 * into the same turn models the session page builds.
 */
function useSessionLedger(sessionId: string) {
  const [snapshot, setSnapshot] = useState<{ sessionId: string; events: LedgerEvent[] } | undefined>(undefined);
  const [pushed, setPushed] = useState<LedgerEvent[]>([]);

  useEffect(() => {
    let cancelled = false;
    setSnapshot(undefined);
    setPushed([]);
    void getSessionBridge().ledgerSnapshot(sessionId).then((events) => {
      if (!cancelled) setSnapshot({ sessionId, events });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [sessionId]);

  useEffect(() => getSessionBridge().onEvent((payload) => {
    if (payload.sessionId !== sessionId) return;
    setPushed((current) => current.some((event) => event.seq === payload.event.seq)
      ? current
      : [...current, payload.event]);
  }), [sessionId]);

  const events = useMemo(() => {
    const base = snapshot?.sessionId === sessionId ? snapshot.events : [];
    // Pushed events that landed before the snapshot arrived are deduped by seq.
    const seen = new Set(base.map((event) => event.seq));
    return [...base, ...pushed.filter((event) => !seen.has(event.seq))];
  }, [snapshot, pushed, sessionId]);

  return { events, ready: snapshot?.sessionId === sessionId };
}

/** Reason model of the session's latest turn, used for the budget estimate. */
function latestReasonModel(turns: ReturnType<typeof fold>['turns']): string {
  const turn = turns.at(-1);
  const reason = turn?.calls.filter((call) => call.role === 'reason').at(-1);
  return reason?.model ?? turn?.model.model ?? '';
}

/**
 * Session-scoped body inside its own usage provider: the panel mounts a
 * minimal provider per session so the shared derivation hook reads the same
 * context as on the session page. The provider owns the context inspection and
 * route preview queries once the reason model is known.
 */
function SessionUsageSection({ sessionId }: { sessionId: string }) {
  const { events, ready } = useSessionLedger(sessionId);
  const models = useSessionModels();
  const turns = useMemo(() => fold(events, [], {}, { sessionId }).turns, [events, sessionId]);

  return (
    <SessionUsageProvider
      sessionKey={sessionId}
      models={models.data ?? []}
      events={events}
      turns={turns}
      ledgerReady={ready}
    >
      <SessionUsageSectionBody turns={turns} />
    </SessionUsageProvider>
  );
}

function SessionUsageSectionBody({ turns }: { turns: ReturnType<typeof fold>['turns'] }) {
  // The panel provider has no composer to seed its model selection; seed the
  // latest reason model once so the shared budget/routes queries activate.
  const { modelId } = useSessionUsage();
  const { setModelId } = useComposerSelection();
  const wanted = useMemo(() => latestReasonModel(turns), [turns]);
  useEffect(() => {
    if (modelId === '' && wanted !== '') setModelId(wanted);
  }, [modelId, wanted, setModelId]);
  const data = useSessionUsagePanelData({ turns });
  const panelRef = useRef<HTMLDivElement | null>(null);
  const note = [
    data.runningTasks > 0 ? `${data.runningTasks} 个任务进行中` : undefined,
    data.missingTasks > 0 ? `${data.missingTasks} 个任务缺数据` : undefined,
  ].filter(Boolean).join(' · ') || undefined;

  return (
    <div className="flex flex-col" data-slot="usage-session-section">
      <ContextBreakdown
        roles={data.roles}
        budget={data.budget}
        groups={data.groups}
        modelName={data.models.find((entry) => entry.publicId === data.modelId)?.displayName}
      />
      <SessionUsagePanel
        clusters={data.clusters}
        groups={{ reason: data.callGroups.reason, aux: data.callGroups.aux, task: data.taskGroups }}
        note={note}
        rootRef={panelRef}
        currency={data.currency}
      />
    </div>
  );
}

export function UsagePanel() {
  const activeSession = useActiveSession();
  const focus = useQuotaFocus();
  // The store's one-shot provider scroll target is consumed once here so a
  // stale id never re-scrolls on a later open.
  const [scrollTarget, setScrollTarget] = useState<string | undefined>(undefined);
  useEffect(() => {
    setScrollTarget(consumeActivityPanelProvider());
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-slot="usage-panel">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {activeSession !== '' ? (
          <section>
            <SessionUsageSection sessionId={activeSession} />
          </section>
        ) : null}
        <Separator />
        <QuotaPanel firstProviderId={focus ?? undefined} scrollProviderId={scrollTarget} />
      </div>
      <Separator />
      <PanelFooterAction
        label="工房台账"
        icon={ChartColumn}
        onClick={() => void shell.navigate('stats')}
      />
    </div>
  );
}
