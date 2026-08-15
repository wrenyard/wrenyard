// ── Blueprint Wren entity presenter ─────────────────────────────────
// Small deterministic presenter surface for the entity input loop.

import type { RenderSurface } from '../../render';
import { createWrenScene, type WrenOutput, type WrenScene, WREN_W, WREN_H } from './scene';
import type { TaskGraphEntityDtoWithPresentation } from '../../shared/taskgraph';

export interface WrenEntityPresenter {
  setDto(dto: TaskGraphEntityDtoWithPresentation, nowMs?: number): WrenOutput | undefined;
  updatePose(
    id: string,
    state: string,
    stale: boolean,
    exiting: boolean,
    nowMs: number,
    lifecycle?: {
      terminal?: 'done' | 'cancelled';
      terminalReason?: 'success' | 'node_failed' | 'cancelled';
      errorPaused?: boolean;
      motion?: 'full' | 'reduced';
    },
  ): WrenOutput['clickRect'];
  destroy(): void;
}

export function createWrenEntityPresenter(surface: RenderSurface): WrenEntityPresenter {
  let scene: WrenScene | undefined;

  function ensureScene(): WrenScene {
    if (!scene) {
      scene = createWrenScene(surface);
    }
    return scene;
  }

  function setDto(dto: TaskGraphEntityDtoWithPresentation, nowMs: number = Date.now()): WrenOutput | undefined {
    const s = ensureScene();
    const output = s.update(dto, nowMs);
    surface.render();
    return output;
  }

  function updatePose(
    id: string,
    state: string,
    stale: boolean,
    exiting: boolean,
    nowMs: number,
    lifecycle?: {
      terminal?: 'done' | 'cancelled';
      terminalReason?: 'success' | 'node_failed' | 'cancelled';
      errorPaused?: boolean;
      motion?: 'full' | 'reduced';
    },
  ): WrenOutput['clickRect'] {
    const dto: TaskGraphEntityDtoWithPresentation = {
      id,
      state: (state === 'running' || state === 'paused' || state === 'created' ? state : 'paused') as 'created' | 'running' | 'paused',
      revision: 0,
      created_at: '',
      presentation: exiting ? 'exiting' : stale ? 'stale' : undefined,
    };
    if (lifecycle?.terminal !== undefined) dto.terminal = lifecycle.terminal;
    if (lifecycle?.terminalReason !== undefined) dto.terminal_reason = lifecycle.terminalReason;
    if (lifecycle?.errorPaused !== undefined) dto.error_paused = lifecycle.errorPaused;
    if (lifecycle?.motion !== undefined) dto.motion = lifecycle.motion;
    const s = ensureScene();
    const output = s.update(dto, nowMs);
    surface.render();
    return output.clickRect;
  }

  function destroy(): void {
    scene?.destroy();
    scene = undefined;
  }

  return { setDto, updatePose, destroy };
}
