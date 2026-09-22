import type { HouseRendererState } from '../../shared/entities';
import { stateWithoutBroadcast } from './presenter';

export interface BroadcastDismissResult {
  id?: string;
  state: HouseRendererState;
}

export function dismissBroadcastLocally(state: HouseRendererState): BroadcastDismissResult {
  return {
    id: state.broadcast?.id,
    state: stateWithoutBroadcast(state),
  };
}
