import type { HouseRendererState, RendererConfig, WorkerRendererState } from '../../shared/entities';
import type { SiteSnapshot } from '../../shared/snapshot';
import type { PetApi, SettingsPanelApi, StatsPanelApi } from './pet-api';

type ExpectedPetApi = {
  onSnapshot(cb: (snap: SiteSnapshot) => void): () => void;
  onHouseUpdate(cb: (state: HouseRendererState) => void): () => void;
  onWorkerUpdate(cb: (state: WorkerRendererState) => void): () => void;
  getConfig(): Promise<RendererConfig>;
  setHouseMousePassthrough(passthrough: boolean): void;
  getHouseCursorPoint(): Promise<{ x: number; y: number; inside: boolean } | null>;
  houseDragStart(): void;
  houseDragMove(): void;
  houseDragEnd(): void;
  dismissBroadcast(id?: string): void;
  setWorkerMousePassthrough(id: string, passthrough: boolean): void;
  workerDragStart(id: string): void;
  workerDragMove(id: string): void;
  workerDragEnd(id: string): void;
  openSettings(): Promise<void>;
  openStats(): Promise<void>;
};

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2)
    ? ((<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2) ? true : false)
    : false;

type Assert<T extends true> = T;

type _PetApiSurface = Assert<Equal<PetApi, ExpectedPetApi>>;
type _SettingsPanelApiSurface = Assert<Equal<Window['settingsPanelApi'], SettingsPanelApi>>;
type _StatsPanelApiSurface = Assert<Equal<Window['statsPanelApi'], StatsPanelApi>>;
type _WindowSurface = Assert<Equal<Window['petApi'], PetApi>>;
