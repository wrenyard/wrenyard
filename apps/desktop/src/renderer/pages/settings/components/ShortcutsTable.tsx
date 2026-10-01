import { useMemo, type ReactNode } from 'react';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/renderer/components/ui/empty';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/renderer/components/ui/table';
import { Kbd } from '@/renderer/components/ui/kbd';
import { KNOWN_SHORTCUTS, type KnownShortcut } from '@/shell-contract';
import {
  SHORTCUTS_COMMAND_LABEL,
  SHORTCUTS_EMPTY,
  SHORTCUTS_KEYS_LABEL,
  SHORTCUTS_SCOPE_LABEL,
} from '../model/describe.js';
import { highlightText, shortcutMatches, type SearchQuery } from '../model/search.js';

function keysFor(shortcut: KnownShortcut, platform: NodeJS.Platform): string | null {
  if (platform === 'darwin') return shortcut.mac ?? null;
  return shortcut.other ?? null;
}

function Highlighted({ text, terms }: { text: string; terms: readonly string[] }): ReactNode {
  return highlightText(text, terms).map((segment, index) => (
    segment.match
      ? <mark key={index} className="rounded-sm bg-primary/15 px-0.5 text-foreground">{segment.text}</mark>
      : <span key={index}>{segment.text}</span>
  ));
}

export interface ShortcutsTableProps {
  platform: NodeJS.Platform;
  query: SearchQuery;
}

/**
 * Read-only shortcut table. Only shortcuts that exist on the current platform
 * are listed; the parent search box filters by command name as well as by the
 * key text (e.g. `⌘K` or `Ctrl+K`).
 */
export function ShortcutsTable({ platform, query }: ShortcutsTableProps) {
  const groups = useMemo(() => {
    const ordered: Array<{ category: string; rows: KnownShortcut[] }> = [];
    for (const shortcut of KNOWN_SHORTCUTS) {
      const keys = keysFor(shortcut, platform);
      if (keys === null) continue;
      if (!shortcutMatches({ title: shortcut.title, category: shortcut.category, scope: shortcut.scope, keys }, query)) {
        continue;
      }
      const group = ordered.find((entry) => entry.category === shortcut.category);
      if (group) group.rows.push(shortcut);
      else ordered.push({ category: shortcut.category, rows: [shortcut] });
    }
    return ordered;
  }, [platform, query]);

  if (groups.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{SHORTCUTS_EMPTY}</EmptyTitle>
          <EmptyDescription>{SHORTCUTS_EMPTY}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {groups.map((group) => (
        <div key={group.category} className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">{group.category}</h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{SHORTCUTS_COMMAND_LABEL}</TableHead>
                <TableHead>{SHORTCUTS_KEYS_LABEL}</TableHead>
                <TableHead>{SHORTCUTS_SCOPE_LABEL}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {group.rows.map((shortcut) => {
                const keys = keysFor(shortcut, platform) ?? '';
                return (
                  <TableRow key={`${shortcut.category}-${shortcut.title}`}>
                    <TableCell>
                      <Highlighted text={shortcut.title} terms={query.terms} />
                    </TableCell>
                    <TableCell>
                      <Kbd><Highlighted text={keys} terms={query.terms} /></Kbd>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{shortcut.scope}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ))}
    </div>
  );
}
