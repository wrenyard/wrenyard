import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/renderer/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { formatBuildTime } from '@/renderer/lib/format';
import { settingsQuery } from '@/renderer/lib/queries';

/**
 * Temporary source-build marker (window chrome spec 3.4). It reuses
 * `about.sourceDevelopment` and renders nothing for packaged builds; it moves
 * into the title bar when batch C1 lands.
 */
export function SourceDevelopmentBadge() {
  const settings = useQuery(settingsQuery);
  const about = settings.data?.about;
  if (about?.sourceDevelopment !== true) return null;
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge variant="outline" className="text-warning" />}>开发模式</TooltipTrigger>
      <TooltipContent>
        {`从源码运行（pnpm dev）· Desktop ${about.desktopVersion} · 构建于 ${formatBuildTime(about.buildTime)}`}
      </TooltipContent>
    </Tooltip>
  );
}
