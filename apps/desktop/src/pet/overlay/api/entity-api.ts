import type { EntityStatePayload, EntityPlacementPayload } from '../../main/preload/entity';

export interface EntityApi {
  openSelf(): Promise<void>;
  entityDragStart(): void;
  entityDragMove(): void;
  entityDragEnd(): void;
  setMousePassthrough(passthrough: boolean): Promise<void>;
  getState(): Promise<EntityStatePayload | null>;
  onEntityState(listener: (state: EntityStatePayload) => void): () => void;
  onEntityPlacement(listener: (placement: EntityPlacementPayload) => void): () => void;
}

declare global {
  interface Window { entityApi: EntityApi }
}
