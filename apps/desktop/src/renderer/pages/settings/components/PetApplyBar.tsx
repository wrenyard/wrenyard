import { Button } from '@/renderer/components/ui/button';
import {
  PET_APPLYING_LABEL,
  PET_APPLY_BAR_NOTE,
  PET_APPLY_LABEL,
  PET_DISCARD_LABEL,
  PET_SAVE_FAILED_NOTE,
} from '../model/describe.js';

export interface PetApplyBarProps {
  dirty: boolean;
  applying: boolean;
  failed: boolean;
  onApply: () => void;
  onDiscard: () => void;
}

/**
 * The Pet category keeps bulk apply because reloading the Pet window on every
 * change flickers. The bar stays pinned to the bottom of the content area
 * while there are unapplied edits.
 */
export function PetApplyBar({ dirty, applying, failed, onApply, onDiscard }: PetApplyBarProps) {
  if (!dirty) return null;
  return (
    <div className="sticky bottom-0 z-20 -mx-3 mt-2 flex items-center justify-between gap-3 border-t bg-background/95 px-3 py-2 backdrop-blur">
      <span className={failed ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'} role="status">
        {failed ? PET_SAVE_FAILED_NOTE : PET_APPLY_BAR_NOTE}
      </span>
      <div className="flex items-center gap-2">
        <Button variant="outline" disabled={applying} onClick={onDiscard}>{PET_DISCARD_LABEL}</Button>
        <Button disabled={applying} onClick={onApply}>{applying ? PET_APPLYING_LABEL : PET_APPLY_LABEL}</Button>
      </div>
    </div>
  );
}
