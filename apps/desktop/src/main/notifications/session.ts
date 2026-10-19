// Session producer: live turn.finished events after catch-up. Completed shows truncated reply text (the committed system "reply" action result) or a fallback title; failed shows an error summary; interrupted is ignored.

import type { LedgerEvent } from '@wrenyard/session';
import type { AppNotification, Notifier } from './notifier.js';

const REPLY_TEXT_MAX = 120;
const ERROR_TEXT_MAX = 80;
const SESSION_TITLE_FALLBACK = '新对话';

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export interface SessionNotifier {
  observe(sessionId: string, event: LedgerEvent): void;
}

export interface SessionNotifierDeps {
  notifier: Notifier;
}

export function createSessionNotifier(deps: SessionNotifierDeps): SessionNotifier {
  /** Last committed reply text per `sessionId:turn`, for the live turn only. */
  const lastReply = new Map<string, string>();
  /** Latest display title from live `session.titled` events. */
  const lastTitle = new Map<string, string>();

  return {
    observe(sessionId: string, event: LedgerEvent): void {
      if (event.type === 'session.titled') {
        const title = collapse(event.text);
        if (title.length > 0) lastTitle.set(sessionId, title);
        return;
      }
      if (event.type === 'reply.sent') {
        if (event.turn === undefined) return;
        lastReply.set(`${sessionId}:${event.turn}`, event.text);
        return;
      }
      if (event.type !== 'turn.finished') return;
      if (event.status === 'interrupted') return;
      const key = event.turn === undefined ? null : `${sessionId}:${event.turn}`;
      const sessionTitle = lastTitle.get(sessionId) ?? SESSION_TITLE_FALLBACK;
      let notification: AppNotification;
      if (event.status === 'completed') {
        const reply = key === null ? undefined : lastReply.get(key);
        if (key !== null) lastReply.delete(key);
        const collapsed = reply !== undefined ? collapse(reply) : '';
        notification = {
          id: `session:${sessionId}`,
          level: 'success',
          title: sessionTitle,
          ...(collapsed.length > 0 ? { body: truncate(collapsed, REPLY_TEXT_MAX) } : {}),
          action: {
            label: '打开',
            command: { id: 'session.open', args: { sessionId } },
          },
        };
      } else {
        const error = typeof event.error === 'string' ? collapse(event.error) : '';
        notification = {
          id: `session:${sessionId}`,
          level: 'error',
          title: sessionTitle,
          body: error.length > 0 ? truncate(error, ERROR_TEXT_MAX) : '对话因请求异常中断',
          action: {
            label: '打开',
            command: { id: 'session.open', args: { sessionId } },
          },
        };
      }
      deps.notifier.notify(notification, ['pet', 'inApp', 'system']);
    },
  };
}
