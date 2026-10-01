import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bell, BellOff, CheckCircle2, CircleX, Info, TriangleAlert, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/renderer/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/renderer/components/ui/popover';
import { ScrollArea } from '@/renderer/components/ui/scroll-area';
import { Separator } from '@/renderer/components/ui/separator';
import { StatusBarButton } from '@/renderer/components/status-bar-button';
import { executeCommand } from '@/renderer/lib/commands';
import { shell } from '@/renderer/lib/desktop';
import type { NotificationLevel, ShellNotification } from '@/shell-contract';
import { cn } from 'cn';

/**
 * Status-bar notification item (window-chrome spec 4.8). It displays the process-owned
 * notification history: the bell toggles the popover, marks history read on
 * open, and lets the user dismiss, clear or deep-link through each entry's
 * command action.
 */

const NOTIFICATIONS_KEY = ['notifications'] as const;

const LEVEL_ICON: Readonly<Record<NotificationLevel, LucideIcon>> = {
  info: Info,
  success: CheckCircle2,
  warning: TriangleAlert,
  error: CircleX,
};

const LEVEL_CLASS: Readonly<Record<NotificationLevel, string>> = {
  info: 'text-muted-foreground',
  success: 'text-success',
  warning: 'text-warning',
  error: 'text-destructive',
};

/** `HH:mm`; notifications are session-scoped so the clock is enough. */
function formatNotificationTime(createdAt: number): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(createdAt);
}

function NotificationRow({ item, onClose }: { item: ShellNotification; onClose: () => void }) {
  const Icon = LEVEL_ICON[item.level];
  const action = item.action;
  return (
    <div className="flex items-start gap-2 border-b border-border/40 px-3 py-2 last:border-b-0">
      <Icon className={cn('mt-0.5 size-4 shrink-0', LEVEL_CLASS[item.level])} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-xs font-medium">{item.title}</span>
          <span className="ml-auto shrink-0 tabular-nums text-xs text-muted-foreground">
            {formatNotificationTime(item.createdAt)}
          </span>
        </div>
        {item.description ? <p className="text-xs text-muted-foreground">{item.description}</p> : null}
        {action ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="mt-0.5 self-start"
            onClick={() => {
              executeCommand(action.command.id, action.command.args);
              onClose();
            }}
          >
            {action.label}
          </Button>
        ) : null}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="关闭通知"
        onClick={() => void shell.dismissNotification(item.id)}
      >
        <X />
      </Button>
    </div>
  );
}

export function NotificationItem() {
  const [open, setOpen] = useState(false);
  const notifications = useQuery({
    queryKey: NOTIFICATIONS_KEY,
    queryFn: () => shell.getNotifications(),
    staleTime: Infinity,
  });


  const snapshot = notifications.data;
  const unread = snapshot?.unreadCount ?? 0;
  const doNotDisturb = snapshot?.doNotDisturb ?? false;
  const items = snapshot?.items ?? [];

  const handleOpenChange = (next: boolean): void => {
    setOpen(next);
    if (next) void shell.markNotificationsRead();
  };

  return (
    <div className="relative inline-flex">
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger nativeButton={false} render={<span className="inline-flex" />}>
          <StatusBarButton
            icon={doNotDisturb ? BellOff : Bell}
            tooltip={doNotDisturb ? '通知（免打扰）' : '通知'}
            ariaLabel="通知"
          />
        </PopoverTrigger>
        <PopoverContent side="top" align="end" className="flex h-[480px] w-[380px] flex-col p-0">
          <div className="flex items-center gap-1 px-3 py-2">
            <span className="text-sm font-medium">通知</span>
            <div className="ml-auto flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={unread === 0}
                onClick={() => void shell.markNotificationsRead()}
              >
                全部已读
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={doNotDisturb ? '关闭免打扰' : '开启免打扰'}
                onClick={() => void shell.setDoNotDisturb(!doNotDisturb)}
              >
                {doNotDisturb ? <Bell /> : <BellOff />}
              </Button>
            </div>
          </div>
          <Separator />
          <ScrollArea className="min-h-0 flex-1">
            {items.length === 0 ? (
              <p className="px-4 py-10 text-center text-xs text-muted-foreground">暂无通知</p>
            ) : (
              <div className="flex flex-col">
                {items.map((item) => (
                  <NotificationRow key={item.id} item={item} onClose={() => setOpen(false)} />
                ))}
              </div>
            )}
          </ScrollArea>
          <Separator />
          <div className="flex items-center justify-between gap-2 p-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={items.length === 0}
              onClick={() => void shell.clearNotifications()}
            >
              清空
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                executeCommand('settings.open', 'notifications');
                setOpen(false);
              }}
            >
              通知设置…
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      {unread > 0 ? (
        <span className="pointer-events-none absolute top-0.5 right-0.5 size-1.5 rounded-full bg-destructive" />
      ) : null}
    </div>
  );
}
