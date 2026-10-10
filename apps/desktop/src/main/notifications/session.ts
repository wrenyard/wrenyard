// Session producer: live turn.finished events after catch-up. Completed shows truncated reply text or a fallback title; failed shows an error summary; interrupted is ignored.

import type { LedgerEvent } from '@wrenyard/session';
import type { AppNotification, Notifier } from './notifier.js';

const REPLY_TEXT_MAX = 120;
const ERROR_TEXT_MAX = 80;

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

  return {
    observe(sessionId: string, event: LedgerEvent): void {
      if (event.type === 'reply') {
        if (event.turn === undefined) return;
        lastReply.set(`${sessionId}:${event.turn}`, event.text);
        return;
      }
      if (event.type !== 'turn.finished') return;
      if (event.status === 'interrupted') return;
      const key = event.turn === undefined ? null : `${sessionId}:${event.turn}`;
      let notification: AppNotification;
      if (event.status === 'completed') {
        const reply = key === null ? undefined : lastReply.get(key);
        if (key !== null) lastReply.delete(key);
        const text = reply !== undefined && collapse(reply).length > 0
          ? truncate(collapse(reply), REPLY_TEXT_MAX)
          : '本轮对话已结束';
        notification = {
          id: `session:${sessionId}`,
          level: 'success',
          title: text,
        };
      } else {
        const error = typeof event.error === 'string' ? collapse(event.error) : '';
        notification = {
          id: `session:${sessionId}`,
          level: 'error',
          title: '对话因请求异常中断',
          ...(error.length > 0 ? { body: truncate(error, ERROR_TEXT_MAX) } : {}),
        };
      }
      deps.notifier.notify(notification, ['pet']);
    },
  };
}
