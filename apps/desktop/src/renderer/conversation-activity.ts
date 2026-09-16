import type { ConversationActivityItem, ConversationSnapshot, TaskRunSnapshot, WrenyardShellApi } from '../shell-contract.js';

/** Live status source; only explicitly associated runs enrich a conversation. */
export class ConversationActivityView {
  private readonly items = new Map<string, ConversationActivityItem>();
  private known = new Set<string>();

  constructor(api: WrenyardShellApi, onChange: () => void) {
    const poll = async (): Promise<void> => {
      if (!document.hidden && document.documentElement.dataset.page === 'workbench') {
        try {
          let changed = false;
          for (const item of await api.getConversationActivity()) {
            const id = item.taskRunId;
            if (!id || !this.known.has(id)) continue;
            if (this.items.get(id)?.status !== item.status) changed = true;
            this.items.set(id, item);
          }
          if (changed) onChange();
        } catch { /* Retain observed state during transient failures. */ }
      }
      window.setTimeout(() => void poll(), 1500);
    };
    void poll();
  }

  enrich(snapshot: ConversationSnapshot): ConversationSnapshot {
    this.known = new Set(snapshot.items.flatMap((item) => item.taskRun ? [item.taskRun.taskRunId] : []));
    for (const id of this.items.keys()) if (!this.known.has(id)) this.items.delete(id);
    return { ...snapshot, items: snapshot.items.map((item) => {
      if (!item.taskRun) return item;
      const live = this.items.get(item.taskRun.taskRunId);
      if (!live) return item;
      // A stale poll must not regress a completed tool result back to running.
      const terminal = (value?: string): boolean => !!value && ['done', 'failed', 'cancelled', 'interrupted'].includes(value);
      if (terminal(item.taskRun.status) && !terminal(live.status)) return item;
      if (!['queued', 'running', 'done', 'failed', 'cancelled', 'interrupted'].includes(live.status)) return item;
      return { ...item, taskRun: { ...item.taskRun, status: live.status as TaskRunSnapshot['status'] } };
    }) };
  }
}
