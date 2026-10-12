import { createContext, useContext } from 'react';

/** Shared expansion state for the inspector session tree. */
export interface TreeExpansion {
  isOpen(id: string): boolean;
  toggle(id: string): void;
}

export const TreeExpansionContext = createContext<TreeExpansion | null>(null);

export function useTreeExpansion(): TreeExpansion {
  const value = useContext(TreeExpansionContext);
  if (value === null) throw new Error('useTreeExpansion must be used within SessionTree');
  return value;
}
