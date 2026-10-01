/**
 * Application command table. A command is an id-addressed action shared by
 * notification actions, the title bar and the status bar; because main-process
 * notifications cannot carry a function across IPC, every cross-process
 * reference is a `{ id, args }` pair resolved here.
 *
 * Resolution order: the global routes (navigation) always win, then the
 * commands registered by the currently visible page. Page commands unregister
 * when their `<Activity>` hides, so delivery to a hidden page is impossible;
 * an unresolved command is held in a bounded pending queue and delivered when
 * a page owning that id registers while visible.
 */
import type { ShellPage } from '@/shell-contract';
import { isShellPage } from '@/shell-contract';
import { onCommandAction, onViewChanged, shell } from '@/renderer/lib/desktop';
import { back, forward, toggleSecondarySidebar } from '@/renderer/lib/navigation';
import { requestQuotaPanelOpen } from '@/renderer/lib/statusbar';
import {
  LOCAL_NOTIFICATION_ACTION_ID,
  runLocalNotificationAction,
  setNotificationActionRunner,
} from '@/renderer/lib/notify';

export interface CommandDefinition {
  id: string;
  title: string;
  run: (args?: unknown) => void;
}

export { LOCAL_NOTIFICATION_ACTION_ID };

const globalCommands = new Map<string, CommandDefinition>();
const pageCommands = new Map<ShellPage, Map<string, CommandDefinition>>();

/** Unresolved commands, bounded so a flood cannot grow without limit. */
const PENDING_LIMIT = 32;
let pending: Array<{ id: string; args?: unknown }> = [];
let currentPage: ShellPage = 'session';

function pageFromArgs(args: unknown): ShellPage | null {
  if (isShellPage(args)) return args;
  if (args !== null && typeof args === 'object' && 'page' in args) {
    const page = (args as { page?: unknown }).page;
    if (isShellPage(page)) return page;
  }
  return null;
}

function runNavPage(args: unknown): void {
  const page = pageFromArgs(args);
  if (page) void shell.navigate(page);
}

function runTaskOpen(args: unknown): void {
  const taskRunId = typeof args === 'string'
    ? args
    : args !== null && typeof args === 'object' && typeof (args as { taskRunId?: unknown }).taskRunId === 'string'
      ? (args as { taskRunId: string }).taskRunId
      : undefined;
  if (taskRunId) void shell.openTaskTranscript(taskRunId);
}

const ROUTED_PAGES: Readonly<Record<string, ShellPage>> = {
  'session.open': 'session',
  'session.inspectContext': 'session',
  'settings.open': 'settings',
  'tasks.open': 'tasks',
};

function enqueue(id: string, args?: unknown): void {
  if (pending.length >= PENDING_LIMIT) pending.shift();
  pending.push(args === undefined ? { id } : { id, args });
}

/** Global routes; registered once at module load. */
export const GLOBAL_COMMANDS: readonly CommandDefinition[] = [
  { id: 'nav.page', title: '切换页面', run: runNavPage },
  { id: 'nav.back', title: '后退', run: () => back() },
  { id: 'nav.forward', title: '前进', run: () => forward() },
  { id: 'view.toggleSidebar', title: '折叠侧栏', run: () => toggleSecondarySidebar() },
  { id: 'task.open', title: '查看任务', run: runTaskOpen },
  { id: 'quota.showPanel', title: '查看额度', run: () => requestQuotaPanelOpen() },
];

for (const command of GLOBAL_COMMANDS) globalCommands.set(command.id, command);

/**
 * Register a global command available on every page. Returns a cleanup that
 * removes exactly this definition (a later duplicate id stays untouched).
 */
export function registerCommand(definition: CommandDefinition): () => void {
  globalCommands.set(definition.id, definition);
  return () => {
    if (globalCommands.get(definition.id) === definition) globalCommands.delete(definition.id);
  };
}

/**
 * Register the commands owned by one page. Call inside a page effect; the
 * returned cleanup runs when the page's `<Activity>` hides, so the commands
 * exist only while the page is visible.
 */
export function registerPageCommands(
  page: ShellPage,
  definitions: readonly CommandDefinition[],
): () => void {
  let registry = pageCommands.get(page);
  if (!registry) {
    registry = new Map();
    pageCommands.set(page, registry);
  }
  for (const definition of definitions) registry.set(definition.id, definition);
  if (page === currentPage) deliverPending(definitions);
  return () => {
    const current = pageCommands.get(page);
    if (!current) return;
    for (const definition of definitions) {
      if (current.get(definition.id) === definition) current.delete(definition.id);
    }
    if (current.size === 0) pageCommands.delete(page);
  };
}

/**
 * Execute a command by id. Returns true when a command ran immediately; false
 * when the id is unknown or its page is not visible (the request is then held
 * as a bounded pending command).
 */
export function executeCommand(id: string, args?: unknown): boolean {
  const route = ROUTED_PAGES[id];
  if (route) {
    const command = pageCommands.get(route)?.get(id);
    if (route === currentPage && command) {
      command.run(args);
      return true;
    }
    enqueue(id, args);
    void shell.navigate(route);
    return false;
  }
  const global = globalCommands.get(id);
  if (global) {
    global.run(args);
    return true;
  }
  const visible = pageCommands.get(currentPage)?.get(id);
  if (visible) {
    visible.run(args);
    return true;
  }
  enqueue(id, args);
  return false;
}

function deliverPending(definitions: readonly CommandDefinition[]): void {
  if (pending.length === 0) return;
  const remaining: Array<{ id: string; args?: unknown }> = [];
  for (const request of pending) {
    const definition = definitions.find((candidate) => candidate.id === request.id);
    if (definition) definition.run(request.args);
    else remaining.push(request);
  }
  pending = remaining;
}

// Track the visible page for command resolution and deliver main-process
// command actions (e.g. a native-notification click) through the table.
onViewChanged((page) => {
  currentPage = page;
});
onCommandAction((action) => {
  executeCommand(action.id, action.args);
});

// A renderer notification callback is addressed by a stable key; the command
// table resolves it so the same action works from a toast or a native click.
setNotificationActionRunner((action) => {
  executeCommand(action.command.id, action.command.args);
});
registerCommand({
  id: LOCAL_NOTIFICATION_ACTION_ID,
  title: '执行通知操作',
  run: (args) => runLocalNotificationAction(args),
});
