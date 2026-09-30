import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

interface Props {
  disabled: boolean;
  onSend(text: string): Promise<void>;
}

export function MessageComposer({ disabled, onSend }: Props) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const pending = useRef(false);

  async function send() {
    if (disabled || pending.current || !draft.trim()) return;
    const text = draft;
    pending.current = true;
    setSending(true);
    setDraft('');
    try { await onSend(text); }
    catch { setDraft((current) => current || text); }
    finally { pending.current = false; setSending(false); }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void send();
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  return <form className="sv2-compose" onSubmit={submit} aria-busy={sending}>
    <textarea aria-label="消息" placeholder="输入消息，可随时开启新的并行轮次" rows={3}
      value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={keyDown} />
    <button type="submit" disabled={disabled || sending || !draft.trim()}>
      {sending ? '发送中…' : '发送'}
    </button>
  </form>;
}
