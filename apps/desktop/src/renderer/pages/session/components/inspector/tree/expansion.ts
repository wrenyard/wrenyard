import { createContext, useContext } from 'react';

/** Shared expansion state for the inspector session tree. */
export interface TreeExpansion {
  isOpen(id: string): boolean;
  toggle(id: string): void;
  /** Expand the target action in 行动 and scroll it into view. */
  jumpToAction(turn: number, cycle: number, actionId: string): void;
}

export const TreeExpansionContext = createContext<TreeExpansion | null>(null);

export function useTreeExpansion(): TreeExpansion {
  const value = useContext(TreeExpansionContext);
  if (value === null) throw new Error('useTreeExpansion must be used within SessionTree');
  return value;
}
