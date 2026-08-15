import { HouseRendererState, RendererConfig, WorkerRendererState } from '../../shared/entities';
import { SiteSnapshot } from '../../shared/snapshot';

export interface PetApi {
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
}

export interface SettingsPanelApi {
  load(): Promise<Record<string, unknown>>;
  save(partial: Record<string, unknown>): Promise<void>;
  saveAndRestart(): Promise<void>;
}

export interface StatsPanelApi {
  load(): Promise<unknown>;
  refresh(): Promise<unknown>;
  onData(cb: (data: unknown) => void): () => void;
  close(): void;
}

declare global {
  interface Window {
    petApi: PetApi;
    settingsPanelApi: SettingsPanelApi;
    statsPanelApi: StatsPanelApi;
    panelClose: () => void;
  }
}
