import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/renderer/components/ui/command';
import { dateGroupOf, type DateGroup } from '@/renderer/lib/format';
import type { SessionSummary } from '../model/types.js';

const GROUPS: DateGroup[] = ['今天', '昨天', '7 天内', '更早'];

export interface SessionSearchProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  sessions: SessionSummary[];
  onSelect(sessionId: string): void;
}

/** `Cmd/Ctrl+K` dialog: search every conversation, grouped by date. */
export function SessionSearch({ open, onOpenChange, sessions, onSelect }: SessionSearchProps) {
  const now = Date.now();
  const grouped = new Map<DateGroup, SessionSummary[]>();
  const sorted = [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const session of sorted) {
    const group = dateGroupOf(session.updatedAt, now);
    const bucket = grouped.get(group);
    if (bucket) bucket.push(session);
    else grouped.set(group, [session]);
  }

  return (
    <CommandDialog title="搜索对话" description="按标题搜索全部会话" open={open} onOpenChange={onOpenChange}>
      <Command>
      <CommandInput placeholder="搜索对话" />
      <CommandList>
        <CommandEmpty>没有匹配的对话</CommandEmpty>
        {GROUPS.map((group) => {
          const list = grouped.get(group);
          if (!list || list.length === 0) return null;
          return (
            <CommandGroup key={group} heading={group}>
              {list.map((session) => (
                <CommandItem
                  key={session.sessionId}
                  value={session.title}
                  onSelect={() => {
                    onSelect(session.sessionId);
                    onOpenChange(false);
                  }}
                >
                  {session.title}
                </CommandItem>
              ))}
            </CommandGroup>
          );
        })}
      </CommandList>
      </Command>
    </CommandDialog>
  );
}
