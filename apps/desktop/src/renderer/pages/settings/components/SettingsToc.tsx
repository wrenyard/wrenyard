import { useState } from 'react';
import {
  Bird,
  Blocks,
  Bot,
  Boxes,
  ChevronRight,
  Download,
  FlaskConical,
  HardDrive,
  Info,
  Keyboard,
  LayoutGrid,
  MessageSquare,
  Palette,
  Route,
  Server,
  Terminal,
  WalletCards,
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
  providers: WalletCards,
  catalog: Boxes,
  routingTest: FlaskConical,
  models: Route,
  clients: Terminal,
  bot: Bot,
  shortcuts: Keyboard,
  pet: Bird,
  components: Blocks,
  runtime: Server,
  storage: HardDrive,
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
 * The settings category directory. It switches pages instead of scrolling:
 * every category in `categories` (all nine, including 快捷键) is a page entry
 * and `onSelectCategory` opens it, with `activeCategory` marking the open page.
 * The count badges keep their search semantics. A category with in-page
 * sub-groups (桌宠) is a Collapsible whose trigger opens the category page, and
 * whose sub-buttons open it too and scroll to the group card.
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
                {category.id !== 'bot' && countBadge(category.count)}
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
                {category.id !== 'bot' && countBadge(category.count)}
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
