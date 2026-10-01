import { useState } from 'react';
import {
  Bell,
  Bird,
  ChevronRight,
  Download,
  Info,
  Keyboard,
  LayoutGrid,
  MessageSquare,
  Palette,
  Route,
  Server,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from 'cn';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/renderer/components/ui/collapsible';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from '@/renderer/components/ui/sidebar';
import type { SettingsCategoryId } from '../model/categories.js';

const CATEGORY_ICONS: Readonly<Record<SettingsCategoryId, LucideIcon>> = {
  general: LayoutGrid,
  appearance: Palette,
  session: MessageSquare,
  models: Route,
  notifications: Bell,
  shortcuts: Keyboard,
  pet: Bird,
  runtime: Server,
  update: Download,
  about: Info,
};

export interface TocGroup {
  key: string;
  label: string;
  count: number;
}

export interface TocCategory {
  id: SettingsCategoryId;
  label: string;
  /** Number of settings in this category matching the current search. */
  count: number;
  groups: TocGroup[];
}

export interface SettingsTocProps {
  categories: readonly TocCategory[];
  activeCategory: SettingsCategoryId | null;
  activeGroup: string | null;
  onSelectCategory: (id: SettingsCategoryId) => void;
  onSelectGroup: (categoryId: SettingsCategoryId, group: string) => void;
}

function countBadge(count: number) {
  return <span className="ml-auto text-xs tabular-nums text-sidebar-foreground/60">{count}</span>;
}

/**
 * The settings category directory. Flat categories are menu buttons; a
 * category with sub-groups is a Collapsible whose trigger also scrolls to the
 * category heading.
 */
export function SettingsToc({
  categories,
  activeCategory,
  activeGroup,
  onSelectCategory,
  onSelectGroup,
}: SettingsTocProps) {
  const [openGroups, setOpenGroups] = useState<ReadonlySet<SettingsCategoryId>>(new Set());

  return (
    <SidebarMenu>
      {categories.map((category) => {
        const Icon = CATEGORY_ICONS[category.id];
        const hasGroups = category.groups.length > 0;
        if (!hasGroups) {
          return (
            <SidebarMenuItem key={category.id}>
              <SidebarMenuButton
                isActive={activeCategory === category.id}
                onClick={() => onSelectCategory(category.id)}
              >
                <Icon />
                <span>{category.label}</span>
                {countBadge(category.count)}
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        }
        const open = openGroups.has(category.id);
        return (
          <Collapsible
            key={category.id}
            open={open}
            onOpenChange={(next) => {
              setOpenGroups((current) => {
                const updated = new Set(current);
                if (next) updated.add(category.id);
                else updated.delete(category.id);
                return updated;
              });
            }}
          >
            <SidebarMenuItem>
              <CollapsibleTrigger
                render={(
                  <SidebarMenuButton
                    isActive={activeCategory === category.id && activeGroup === null}
                    onClick={() => onSelectCategory(category.id)}
                  />
                )}
              >
                <Icon />
                <span>{category.label}</span>
                {countBadge(category.count)}
                <ChevronRight
                  className={cn('ml-1 transition-transform', open && 'rotate-90')}
                  aria-hidden="true"
                />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <SidebarMenuSub>
                  {category.groups.map((group) => (
                    <SidebarMenuSubItem key={group.key}>
                      <SidebarMenuSubButton
                        render={<button type="button" />}
                        isActive={activeCategory === category.id && activeGroup === group.key}
                        onClick={() => onSelectGroup(category.id, group.key)}
                      >
                        <span>{group.label}</span>
                        {countBadge(group.count)}
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  ))}
                </SidebarMenuSub>
              </CollapsibleContent>
            </SidebarMenuItem>
          </Collapsible>
        );
      })}
    </SidebarMenu>
  );
}
