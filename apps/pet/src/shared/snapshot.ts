// Application-layer snapshot types.
// Per final review: Phase, WorkerSnapshot, SessionMetaData are the single source
// in forge-types.ts. This file re-exports them and adds rendering-specific types.

export type { Phase, WorkerSnapshot, SessionMetaData } from '../main/forge-types';
export type { BroadcastInput, BroadcastIntensity, BroadcastSnapshot } from './broadcast';

export type WorkerSkinId =
  | 'classic-codebuddy'
  | 'classic-codex'
  | 'classic-claude'
  | 'classic-voxel-miner'
  | 'red-jumper'
  | 'green-quest'
  | 'blue-dash'
  | 'block-miner'
  | 'space-bounty'
  | 'arcade-ghost'
  | 'rune-mage'
  | 'shadow-ninja'
  | 'slime-king';

export interface WorkerSkinColors {
  primary: string;
  accent: string;
  tool: string;
}

/**
 * Role category for a worker skin.
 * - `official`: branded mascot for a supported client family (codebuddy/codex/claude).
 * - `classic`: the legacy classic-voxel-miner skin.
 * - `original`: the nine generated per-run-themed skins.
 */
export type WorkerSkinKind = 'official' | 'classic' | 'original';

export interface WorkerSkin {
  kind: WorkerSkinKind;
  id: WorkerSkinId;
  name: string;
  colors: WorkerSkinColors;
}

export interface Appearance {
  profile: string | null;
  profileLabel: string;
  skin: WorkerSkin;
}

export type WorkerClient = 'claude' | 'codebuddy' | 'codex' | 'unknown';

export interface SiteSnapshot {
  workers: import('../main/forge-types').WorkerSnapshot[];
  queuedCount: number;
  broadcast?: import('./broadcast').BroadcastSnapshot;
  dailyStats?: DailyStatsSnapshot;
  /**
   * True when the latest activity.snapshot round failed and the published
   * presence is the previous complete state re-emitted as uniformly stale.
   * Consumers keep every count/surface and append "signal lost" instead of
   * clearing anything.
   */
  activityStale?: boolean;
  /** Number of non-terminal TaskGraph drawings from the same activity
   *  snapshot (house hover shows `G 张图纸`). Present only when > 0. */
  taskgraphCount?: number;
}

export interface DailyStatsSnapshot {
  dayKey: string;
  startAt: string;
  endAt: string;
  dispatchCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  source: 'sqlite';
}

/**
 * View-level wrapper for renderers — enriches WorkerSnapshot with
 * rendering-only fields computed during snapshot emission.
 */
export interface WorkerView {
  workerIdentityKey: string;
  profile: string;
  client: WorkerClient;
  phase: import('../main/forge-types').Phase;
  appearance: Appearance;
  sinceMs: number;
  toolCount: number;
  lastToolTs?: number;
  /** Renderer-only pulse hook for output/event activity. Does not encode the transport protocol. */
  lastActivityTs?: number;
  /** Renderer-only pulse hook for assistant content output. */
  lastContentTs?: number;
  bubble?: { text: string; untilMs: number };
  startedAt: number;
  taskLabel?: string;
  taskId?: string;
  taskName?: string;
}
