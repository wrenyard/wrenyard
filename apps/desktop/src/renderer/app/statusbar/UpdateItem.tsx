import { ArrowUp } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { StatusBarButton } from '@/renderer/components/status-bar-button';
import { UPDATE_VISIBLE_STATES } from '@/renderer/app/nav';
import { updateQuery } from '@/renderer/lib/queries';

/**
 * Status-bar update item (window-chrome spec 4.7). It appears only while an
 * update is actionable and delegates opening the update dialog to the shell.
 */
export function UpdateItem({ onOpenUpdate }: { onOpenUpdate: () => void }) {
  const update = useQuery(updateQuery);
  const state = update.data?.state;
  if (state === undefined || !UPDATE_VISIBLE_STATES.some((visible) => visible === state)) return null;
  return <StatusBarButton icon={ArrowUp} label="有更新" tooltip="有可用更新" onClick={onOpenUpdate} />;
}
