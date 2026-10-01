import { Copy } from 'lucide-react';
import { Button } from '@/renderer/components/ui/button';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import { copyText } from '@/renderer/lib/desktop';
import { useThemeIcon } from '@/renderer/lib/theme';
import {
  ABOUT_BUILD_TIME_LABEL,
  ABOUT_DESKTOP_LABEL,
  ABOUT_DIAGNOSTIC_COPY_LABEL,
  ABOUT_THEME_LABEL,
  ABOUT_WRENYARD_LABEL,
  DAEMON_STATE_LABEL,
} from '../model/describe.js';
import { formatBuildTime } from '../model/settings.js';
import { useDaemonQuery, useSettingsQuery } from '../queries.js';

function CopyRow({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm tabular-nums text-muted-foreground">{value}</span>
      <Button variant="ghost" size="icon-xs" aria-label={label} onClick={() => { void copyText(value); }}>
        <Copy />
      </Button>
    </div>
  );
}

/** Current theme icon, read-only. */
export function AboutThemeControl() {
  const themeIcon = useThemeIcon();
  return (
    <div className="flex items-center gap-3">
      <img className="size-12 shrink-0 rounded-lg" src={themeIcon} alt="" aria-hidden="true" />
      <span className="text-sm text-muted-foreground">{ABOUT_THEME_LABEL}</span>
    </div>
  );
}

export function AboutWrenyardVersionControl() {
  const settings = useSettingsQuery();
  const about = settings.data?.about;
  if (about === undefined) return <Skeleton className="h-5 w-24" />;
  return <CopyRow value={about.wrenyardVersion} label={`复制 ${ABOUT_WRENYARD_LABEL}`} />;
}

export function AboutDesktopVersionControl() {
  const settings = useSettingsQuery();
  const about = settings.data?.about;
  if (about === undefined) return <Skeleton className="h-5 w-24" />;
  return <CopyRow value={about.desktopVersion} label={`复制 ${ABOUT_DESKTOP_LABEL}`} />;
}

export function AboutBuildTimeControl() {
  const settings = useSettingsQuery();
  const about = settings.data?.about;
  if (about === undefined) return <Skeleton className="h-5 w-40" />;
  const value = formatBuildTime(about.buildTime);
  return <CopyRow value={value} label={`复制 ${ABOUT_BUILD_TIME_LABEL}`} />;
}

/** Copies a one-paragraph diagnostic summary for bug reports. */
export function AboutDiagnosticsControl() {
  const settings = useSettingsQuery();
  const daemon = useDaemonQuery();
  const about = settings.data?.about;
  const mode = daemon.data?.mode ?? 'unknown';
  const state = daemon.data?.state;
  const diagnostic = [
    `Wrenyard ${about?.wrenyardVersion ?? 'unknown'}`,
    `Desktop ${about?.desktopVersion ?? 'unknown'}`,
    `构建时间 ${about?.buildTime ?? 'unknown'}`,
    `平台 ${navigator.platform}`,
    `Daemon ${state === undefined ? 'unknown' : DAEMON_STATE_LABEL[state]}（${mode}）`,
  ].join('\n');
  return (
    <Button variant="outline" onClick={() => { void copyText(diagnostic); }}>
      <Copy />
      {ABOUT_DIAGNOSTIC_COPY_LABEL}
    </Button>
  );
}
