import type { Appearance, Phase, WorkerClient } from '../../src/shared/snapshot';
import type { HouseRendererState } from '../../src/shared/entities';

export interface FixtureViewport {
  width: 640;
  height: 360;
  dpr: 1;
  scale: 5;
  nowMs: 10000;
}

export interface HouseFixtureViewport {
  width: 360;
  height: 460;
  dpr: 1;
  scale: 5;
  nowMs: 10000;
}

export interface FixtureWorkerBubble {
  text: string;
  untilMs: number;
}

export interface FixtureWorkerState {
  workerIdentityKey: string;
  profile: string;
  client: WorkerClient;
  phase: Phase;
  appearance: Appearance;
  sinceMs: number;
  toolCount: number;
  lastToolTs?: number;
  lastActivityTs?: number;
  lastContentTs?: number;
  startedAt: number;
  taskName?: string;
  taskLabel?: string;
  taskId?: string;
  bubble?: FixtureWorkerBubble;
}

export interface WorkerPreviewFixture {
  kind: 'worker';
  file: string;
  value: FixtureWorkerState;
  initNowMs: number;
}

export interface HousePreviewFixture {
  kind: 'house';
  file: string;
  value: HouseRendererState;
  pointer: { x: number; y: number; inside: boolean };
  dragging: false;
  initNowMs: number;
}

export const FIXTURE_VIEWPORT: FixtureViewport;
export const HOUSE_FIXTURE_VIEWPORT: HouseFixtureViewport;
export const VALID_SKIN_IDS: readonly Appearance['skin']['id'][];
export const WORKER_FIXTURES: readonly WorkerPreviewFixture[];
export const HOUSE_FIXTURES: readonly HousePreviewFixture[];
export const PREVIEW_FIXTURES: readonly (WorkerPreviewFixture | HousePreviewFixture)[];
export function serializeFixture(fixture: WorkerPreviewFixture | HousePreviewFixture): string;
