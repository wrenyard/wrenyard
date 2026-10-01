// ── Pet notification bridge ──────────────────────────────────────────
// Translates Pet activity transitions into Desktop NotificationCenter
// inputs. The Pet module never raises an OS notification itself: it reports
// every event to the single Desktop owner, which records history, suppresses
// do-not-disturb and decides whether a background notification is warranted,
// so the same task event can never be delivered twice.
import type { NotificationInput, NotificationLevel } from '../../main/notification-center';
import type { GraphTransition } from './model/activity-notifications';

/** Sink injected by the Desktop host; writes into the process-wide center. */
export type PetNotificationSink = (input: NotificationInput) => void;

export interface PetTransitionDescriptor {
  taskgraphId: string;
  fromState: GraphTransition['fromState'];
  toState: GraphTransition['toState'];
  latestSeq: number;
  kind: GraphTransition['kind'];
  /** Localized title already formatted by the transition helper. */
  titleZh: string;
}

function levelFor(kind: GraphTransition['kind']): NotificationLevel {
  if (kind === 'completed') return 'success';
  if (kind === 'error_paused' || kind === 'error_exit') return 'error';
  return 'info';
}

/**
 * Build a serializable notification input for one graph transition. The id is
 * deterministic per transition, so a repeated report updates the existing
 * history entry instead of adding a duplicate.
 */
export function petTransitionNotification(transition: PetTransitionDescriptor): NotificationInput {
  return {
    id: `pet-taskgraph-${transition.taskgraphId}-${transition.fromState ?? 'none'}-${transition.toState}-${transition.latestSeq}`,
    level: levelFor(transition.kind),
    source: 'task',
    title: transition.titleZh,
  };
}
