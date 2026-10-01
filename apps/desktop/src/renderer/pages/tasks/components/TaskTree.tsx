import type { ReactNode } from 'react';
import { ChevronRight, File, Folder } from 'lucide-react';
import { Card, CardContent } from '@/renderer/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/renderer/components/ui/collapsible';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import {
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
} from '@/renderer/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import type { TaskSettingsTaskRow } from '@/shell-contract';
import * as copy from '../model/describe.js';
import {
  taskResolutionFailureMessage,
  type TaskTreeLoadError,
  type TaskTreeModel,
} from '../model/settings.js';

export interface TaskTreeProps {
  model: TaskTreeModel;
  loading: boolean;
  selectedId: string | null;
  collapsed: ReadonlySet<string>;
  onToggleGroup: (key: string) => void;
  onSelect: (identity: string) => void;
}

/** Builtin/project directory tree with collapsible groups and non-executable error leaves. */
export function TaskTree({ model, loading, selectedId, collapsed, onToggleGroup, onSelect }: TaskTreeProps) {
  const empty = model.builtin.length === 0 && model.projects.length === 0 && model.unknownErrors.length === 0;
  return (
    <Card className="flex min-h-0 flex-col">
      <CardContent className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
        {loading && empty ? <TreeSkeleton /> : null}
        {!loading && empty ? <p className="text-muted-foreground">{copy.DIRECTORY_EMPTY}</p> : null}
        <SidebarMenu aria-label={copy.DIRECTORY_LABEL}>
          {model.builtin.length > 0 ? (
            <TreeGroup
              label={copy.CATEGORY_BUILTIN}
              count={model.builtin.length}
              open={!collapsed.has(copy.BUILTIN_GROUP_KEY)}
              onToggle={() => onToggleGroup(copy.BUILTIN_GROUP_KEY)}
            >
              {model.builtin.map((row) => (
                <TaskLeaf key={row.identity} row={row} selected={row.identity === selectedId} onSelect={onSelect} />
              ))}
            </TreeGroup>
          ) : null}
          {model.projects.length > 0 || model.unknownErrors.length > 0 ? (
            <TreeGroup
              label={copy.CATEGORY_PROJECT}
              count={model.projectCategoryCount}
              open={!collapsed.has(copy.PROJECTS_GROUP_KEY)}
              onToggle={() => onToggleGroup(copy.PROJECTS_GROUP_KEY)}
            >
              {model.projects.map((group) => (
                <TreeGroup
                  key={group.key}
                  label={group.label}
                  count={group.rows.length + group.errors.length}
                  open={!collapsed.has(group.key)}
                  onToggle={() => onToggleGroup(group.key)}
                >
                  {group.rows.map((row) => (
                    <TaskLeaf key={row.identity} row={row} selected={row.identity === selectedId} onSelect={onSelect} />
                  ))}
                  {group.errors.map((entry) => (
                    <ErrorLeaf key={`${group.key}:${entry.source_path}`} entry={entry} />
                  ))}
                </TreeGroup>
              ))}
              {model.unknownErrors.length > 0 ? (
                <TreeGroup
                  label={copy.CATEGORY_UNKNOWN_SOURCE}
                  count={model.unknownErrors.length}
                  open={!collapsed.has(copy.UNKNOWN_GROUP_KEY)}
                  onToggle={() => onToggleGroup(copy.UNKNOWN_GROUP_KEY)}
                >
                  {model.unknownErrors.map((entry) => (
                    <ErrorLeaf key={entry.source_path} entry={entry} />
                  ))}
                </TreeGroup>
              ) : null}
            </TreeGroup>
          ) : null}
        </SidebarMenu>
      </CardContent>
    </Card>
  );
}

function TreeGroup({ label, count, open, onToggle, children }: {
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <SidebarMenuItem>
      <Collapsible
        open={open}
        onOpenChange={onToggle}
        className="group/collapsible [&[data-open]>button>svg:first-child]:rotate-90"
      >
        <SidebarMenuButton render={<CollapsibleTrigger />}>
          <ChevronRight className="transition-transform" />
          <Folder />
          <span>{label}</span>
        </SidebarMenuButton>
        <SidebarMenuBadge>{count}</SidebarMenuBadge>
        <CollapsibleContent>
          <SidebarMenuSub>{children}</SidebarMenuSub>
        </CollapsibleContent>
      </Collapsible>
    </SidebarMenuItem>
  );
}

function TaskLeaf({ row, selected, onSelect }: {
  row: TaskSettingsTaskRow;
  selected: boolean;
  onSelect: (identity: string) => void;
}) {
  const failure = taskResolutionFailureMessage(row);
  const body = (
    <>
      <File />
      <span>{row.display_name}</span>
    </>
  );
  if (failure === null) {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton isActive={selected} onClick={() => onSelect(row.identity)}>
          {body}
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  }
  return (
    <SidebarMenuItem>
      <Tooltip>
        <SidebarMenuButton render={<TooltipTrigger />} isActive={selected} onClick={() => onSelect(row.identity)}>
          {body}
        </SidebarMenuButton>
        <TooltipContent>{failure}</TooltipContent>
      </Tooltip>
      <SidebarMenuBadge>{copy.ISSUE_BADGE}</SidebarMenuBadge>
    </SidebarMenuItem>
  );
}

/** Non-executable leaf for a backend load failure: file name plus failure marker. */
function ErrorLeaf({ entry }: { entry: TaskTreeLoadError }) {
  return (
    <SidebarMenuItem>
      <Tooltip>
        <SidebarMenuButton render={<TooltipTrigger />} title={entry.source_path}>
          <File />
          <span>{entry.file_name}</span>
        </SidebarMenuButton>
        <TooltipContent>{entry.message}</TooltipContent>
      </Tooltip>
      <SidebarMenuBadge>{copy.ISSUE_BADGE}</SidebarMenuBadge>
    </SidebarMenuItem>
  );
}

function TreeSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      {[0, 1, 2, 3].map((index) => <Skeleton key={index} className="h-5 w-full" />)}
    </div>
  );
}
