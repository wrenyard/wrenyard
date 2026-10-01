import { Card, CardContent } from '@/renderer/components/ui/card';
import { Separator } from '@/renderer/components/ui/separator';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import { ABOUT_BUILD_TIME_LABEL, ABOUT_DESKTOP_LABEL, ABOUT_WRENYARD_LABEL } from '../model/describe.js';
import { formatBuildTime } from '../model/settings.js';
import { useSettingsQuery } from '../queries.js';

function AboutRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span>{label}</span>
      <span className="text-muted-foreground tabular-nums">{value}</span>
    </div>
  );
}

/** Read-only build identity: Wrenyard, Desktop and the local build time. */
export function AboutSettings() {
  const settings = useSettingsQuery();
  const about = settings.data?.about;

  if (settings.isPending || about === undefined) {
    return (
      <Card>
        <CardContent className="flex flex-col gap-4">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <AboutRow label={ABOUT_WRENYARD_LABEL} value={about.wrenyardVersion} />
        <Separator />
        <AboutRow label={ABOUT_DESKTOP_LABEL} value={about.desktopVersion} />
        <Separator />
        <AboutRow label={ABOUT_BUILD_TIME_LABEL} value={formatBuildTime(about.buildTime)} />
      </CardContent>
    </Card>
  );
}
