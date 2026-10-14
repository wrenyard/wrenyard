import { ArrowUp } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { StatusBarButton } from '@/renderer/components/status-bar-button';
import { UPDATE_VISIBLE_STATES } from '@/renderer/app/nav';
import { updateQuery } from '@/renderer/lib/queries';
import { updateView } from '@/renderer/lib/update';

/**
 * Status-bar update item (window-chrome spec 4.7). It appears only while an
 * update is actionable and delegates opening the update dialog to the shell.
 * The label/tooltip reuse the shared presentation mapping, adding the download
 * percentage when it is known.
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
  return <StatusBarButton icon={ArrowUp} label={label} tooltip={view.description} onClick={onOpenUpdate} />;
}
