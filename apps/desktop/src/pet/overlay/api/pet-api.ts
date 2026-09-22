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
}

declare global {
  interface Window {
    petApi: PetApi;
  }
}
