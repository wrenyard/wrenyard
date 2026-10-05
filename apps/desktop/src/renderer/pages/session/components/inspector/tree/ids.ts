/* Stable expansion ids for the session tree. */

export type PhaseKey = 'prepare' | 'reason' | 'act';

export function turnNodeId(turn: number): string {
  return `turn:${turn}`;
}

export function cycleNodeId(turn: number, cycle: number): string {
  return `turn:${turn}/cycle:${cycle}`;
}

export function phaseNodeId(turn: number, cycle: number, phase: PhaseKey): string {
  return `turn:${turn}/cycle:${cycle}/phase:${phase}`;
}

export function entryNodeId(turn: number, cycle: number, section: string, index: number): string {
  return `turn:${turn}/cycle:${cycle}/${section}/entry:${index}`;
}

export function actionNodeId(actionId: string): string {
  return `action:${actionId}`;
}

export function actionPartId(actionId: string, part: string): string {
  return `action:${actionId}/${part}`;
}

/** DOM id of one action in the 行动 phase, used for jump-and-scroll. */
export function actionAnchorId(actionId: string): string {
  return `tree-action-${actionId}`;
}

/**
 * Children of a tree node: one indent step with a guide line under the
 * parent's chevron, so depth reads from the lines rather than from padding.
 */
export const TREE_CHILDREN = 'ml-[15px] flex flex-col border-l border-border/70 pl-1.5';
