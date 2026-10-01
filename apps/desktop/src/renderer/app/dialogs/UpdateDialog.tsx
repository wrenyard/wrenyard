import { Button } from '@/renderer/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/renderer/components/ui/dialog';
import { UpdatePanel } from '@/renderer/components/update-panel';
import { UPDATE_VISIBLE_STATES } from '@/renderer/app/nav';
import type { UpdateSnapshot } from '@/shell-contract';

/** Whether the footer entry and dialog stay reachable for this snapshot. */
export function isUpdateVisible(snapshot: UpdateSnapshot | undefined): boolean {
  return snapshot !== undefined && (UPDATE_VISIBLE_STATES as readonly string[]).includes(snapshot.state);
}

export interface UpdateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The app's update dialog. It composes the shared update panel — the single
 * source of update status, copy and the check/install action — inside dialog
 * chrome.
 */
export function UpdateDialog({ open, onOpenChange }: UpdateDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>软件更新</DialogTitle>
          <DialogDescription>查看当前版本、更新状态并安装新版本。</DialogDescription>
        </DialogHeader>

        <UpdatePanel />

        <DialogFooter>
          <DialogClose render={<Button variant="ghost">关闭</Button>} />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
