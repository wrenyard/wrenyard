import { useState } from 'react';
import type { SessionApi } from './types.js';
import { useSessionController } from './use-session-controller.js';
import { ConversationTimeline } from './components/ConversationTimeline.js';
import { MessageComposer } from './components/MessageComposer.js';
import { SessionHeader } from './components/SessionHeader.js';
import { SessionSidebar } from './components/SessionSidebar.js';

export function SessionPage({ api }: { api: SessionApi }) {
  const { state, selectSession, createSession, sendMessage, interruptTurn } = useSessionController(api);
  const [modelId, setModelId] = useState('');
  const [effort, setEffort] = useState('');
  const [showRaw, setShowRaw] = useState(false);
  const model = state.models.find((entry) => entry.publicId === modelId) ?? state.models[0];
  const title = state.sessions.find((session) => session.sessionId === state.selectedId)?.title ?? '会话 v2';

  return <div className="sv2-page">
    <SessionSidebar sessions={state.sessions} selectedId={state.selectedId}
      creating={state.creating} loading={state.loadingList}
      onSelect={(id) => { void selectSession(id).catch(() => {}); }}
      onCreate={() => { void createSession().catch(() => {}); }} />
    <main className="sv2-main">
      <SessionHeader title={title} models={state.models} modelId={model?.publicId ?? ''}
        effort={effort} showRaw={showRaw} onEffortChange={setEffort} onRawChange={setShowRaw}
        onModelChange={(value) => { setModelId(value); setEffort(''); }} />
      {state.error && <div className="sv2-error" role="alert">{state.error}</div>}
      <ConversationTimeline key={state.selectedId} events={state.events}
        loading={state.loadingLedger} showRaw={showRaw}
        onInterrupt={(turn) => { void interruptTurn(turn); }} />
      <MessageComposer disabled={!model || state.loadingLedger || state.creating}
        onSend={(text) => {
          if (!model) return Promise.reject(new Error('请先选择可用模型'));
          return sendMessage(text, model, effort);
        }} />
    </main>
  </div>;
}
