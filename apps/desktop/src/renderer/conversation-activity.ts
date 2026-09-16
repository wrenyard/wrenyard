import type { ConversationActivityItem, ConversationSnapshot, WrenyardShellApi } from '../shell-contract.js';

const labels: Record<string, string> = { queued: '排队中', running: '运行中', waiting: '等待中', paused: '已暂停', done: '完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' };

/** Live cards use Pet's display-only snapshot; clicking reuses its transcript window. */
export class ConversationActivityView {
  private items: ConversationActivityItem[] = [];
  private snapshot?: ConversationSnapshot;
  private loading = false;

  constructor(private readonly api: WrenyardShellApi, private readonly feed: HTMLElement) {
    const poll = async (): Promise<void> => {
      if (!document.hidden && document.documentElement.dataset.page === 'workbench' && !this.loading) {
        this.loading = true;
        try { this.items = await api.getConversationActivity(); }
        catch { this.items = []; }
        finally { this.loading = false; }
        this.render();
      }
      window.setTimeout(() => void poll(), 1500);
    };
    void poll();
  }

  update(snapshot: ConversationSnapshot): void { this.snapshot = snapshot; this.render(); }

  private render(): void {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    const articles = Array.from(this.feed.querySelectorAll<HTMLElement>('[data-turn-id]'));
    for (const [index, article] of articles.entries()) {
      const turnId = article.dataset.turnId;
      const items: ConversationActivityItem[] = snapshot.items.flatMap((item) => {
        if (item.turnId !== turnId || !item.taskRun) return [];
        return [{ id: item.taskRun.taskRunId, taskRunId: item.taskRun.taskRunId,
          label: item.taskRun.taskName ?? item.toolSummary?.replace(/^运行任务\s*/, '') ?? item.taskRun.taskId,
          status: item.taskRun.status ?? (item.toolState === 'failed' ? 'failed' : item.toolState === 'running' ? 'running' : 'done'),
          runtime: item.taskRun.resolvedProfile }];
      });
      if (index === articles.length - 1) {
        const known = new Set(items.map((item) => item.id));
        items.push(...this.items.filter((item) => !known.has(item.id)));
      }
      let box = article.querySelector<HTMLElement>('.conversation-system-activity');
      if (items.length === 0) { box?.remove(); continue; }
      const signature = JSON.stringify(items);
      if (box?.dataset.signature === signature) continue;
      if (!box) {
        box = document.createElement('section');
        box.className = 'conversation-system-activity';
        const process = article.querySelector('.turn-activity');
        process?.after(box);
      }
      box.dataset.signature = signature;
      const title = document.createElement('small');
      title.textContent = '系统活动';
      box.replaceChildren(title, ...items.map((item) => this.card(item)));
    }
  }

  private card(item: ConversationActivityItem): HTMLElement {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'conversation-task-card';
    const active = ['running', 'waiting', 'queued'].includes(item.status);
    card.classList.toggle('is-running', active);
    const state = labels[item.status] ?? item.status;
    const icon = document.createElement('span');
    icon.className = 'conversation-task-state';
    icon.setAttribute('aria-hidden', 'true');
    const success = item.status === 'done';
    card.classList.toggle('is-done', success);
    card.classList.toggle('is-error', !active && !success);
    const path = active
      ? '<path d="M20 12a8 8 0 1 1-8-8"/>'
      : success ? '<path d="m5 12 4 4 10-10"/>'
        : '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/>';
    icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
    const name = document.createElement('span');
    name.textContent = item.label;
    card.append(icon, name);
    card.setAttribute('aria-label', `${item.label} · ${state}`);
    card.title = [item.label, state, item.project, item.runtime, item.taskRunId ? '点击查看任务对话' : undefined].filter(Boolean).join('\n');
    card.disabled = !item.taskRunId;
    card.addEventListener('click', async () => {
      if (!item.taskRunId) return;
      card.disabled = true;
      try { await this.api.openTaskTranscript(item.taskRunId); }
      catch (error) { card.title = `${item.label} · 无法打开：${error instanceof Error ? error.message : String(error)}`; }
      finally { card.disabled = false; }
    });
    return card;
  }
}
