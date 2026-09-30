import type { SessionSummary } from '../types.js';

interface Props {
  sessions: SessionSummary[];
  selectedId: string;
  creating: boolean;
  loading: boolean;
  onSelect(sessionId: string): void;
  onCreate(): void;
}

export function SessionSidebar({ sessions, selectedId, creating, loading, onSelect, onCreate }: Props) {
  return <aside className="sv2-sidebar">
    <button type="button" className="sv2-new" disabled={creating} onClick={onCreate}>
      {creating ? '正在创建…' : '新建会话'}
    </button>
    <nav className="sv2-list" aria-label="会话列表" aria-busy={loading}>
      {sessions.map((session) => <button
        type="button" key={session.sessionId}
        aria-current={session.sessionId === selectedId ? 'page' : undefined}
        className={session.sessionId === selectedId ? 'sv2-selected' : undefined}
        onClick={() => onSelect(session.sessionId)}
      >{session.title}</button>)}
      {loading && <p role="status">正在加载会话…</p>}
    </nav>
  </aside>;
}
