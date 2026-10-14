import { ArrowUp } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { SidebarMenuButton, SidebarMenuItem } from '@/renderer/components/ui/sidebar';
import { UPDATE_VISIBLE_STATES } from '@/renderer/app/nav';
import { updateQuery } from '@/renderer/lib/queries';
import { updateView } from '@/renderer/lib/update';

/**
 * Global-sidebar update row. It appears only while an update is actionable and
 * delegates opening the update dialog to the shell. The label/tooltip reuse the
 * shared presentation mapping, adding the download percentage when it is known.
 * States without a snapshot, `checking` and `up-to-date` stay hidden.
 */
export function UpdateItem({ onOpenUpdate }: { onOpenUpdate: () => void }) {
  const update = useQuery(updateQuery);
  const state = update.data?.state;
  if (state === undefined || !UPDATE_VISIBLE_STATES.some((visible) => visible === state)) return null;
  const view = updateView(update.data, false);
  const progress = update.data?.progress;
  const label = progress?.phase === 'downloading' && progress.percent !== undefined
    ? `${view.label} ${progress.percent}%`
    : view.label;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton tooltip={view.description} onClick={onOpenUpdate}>
        <ArrowUp />
        <span>{label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
