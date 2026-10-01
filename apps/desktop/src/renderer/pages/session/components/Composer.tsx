import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { countInputTokens } from '../model/usage.js';
import { EffortPicker, ModelPicker, type ModelOption } from '@/renderer/components/chat/model-picker';
import { PromptInput } from '@/renderer/components/chat/prompt-input';
import { shell } from '@/renderer/lib/desktop';
import { preferencesQuery } from '@/renderer/lib/queries';
import type { SessionPreferences } from '@/shell-contract';
import type { ModelEntry, TurnModel } from '../model/types.js';
import { clearDraft, flushDraft, readDraft, writeDraft } from '../state/drafts.js';
import { onSessionModelRequest, publishComposerState } from '../state/usage-selection.js';
import { ContextMeter } from './usage/ContextMeter.js';

/** Input text is token-counted 300ms after typing stops (usage spec 3.3). */
const INPUT_TOKEN_DEBOUNCE_MS = 300;

/**
 * Debounced `cl100k_base` count of the composer text, including a paste. The
 * first count is `undefined`; the meter treats that as zero so the base ring
 * shows immediately.
 */
function useInputTokenCount(text: string): number | undefined {
  const [tokens, setTokens] = useState<number | undefined>(undefined);
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        setTokens(countInputTokens(text));
      } catch {
        // Token counting is best-effort; the meter falls back to zero.
      }
    }, INPUT_TOKEN_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);
  return tokens;
}

/** Legacy pre-bridge storage key; migrated once into the main preference. */
const LAST_SENT_KEY = 'session:last-sent';

interface LegacyLastSent {
  model: string;
  effort: string;
}

function readLegacyLastSent(): LegacyLastSent | undefined {
  try {
    const raw = window.localStorage.getItem(LAST_SENT_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<LegacyLastSent>;
    return { model: parsed.model ?? '', effort: parsed.effort ?? '' };
  } catch {
    return undefined;
  }
}

function clearLegacyLastSent(): void {
  try {
    window.localStorage.removeItem(LAST_SENT_KEY);
  } catch {
    // Removing the legacy key is best-effort.
  }
}

/** Keeps a reasoning effort only when the target model supports it. */
function supportedEffort(entry: ModelEntry | undefined, effort: string): string {
  if (effort === '') return '';
  return (entry?.thinkingLevels ?? []).includes(effort) ? effort : '';
}

/** Mirror of the persisted session defaults, used until the preference loads. */
const DEFAULT_SESSION_PREFS: SessionPreferences = {
  defaultModel: 'last',
  model: null,
  effort: null,
  lastSentModel: null,
  lastSentEffort: null,
  sendKey: 'enter',
};

export interface ComposerProps {
  models: ModelEntry[];
  turns: TurnModel[];
  /** Changes on session switch (or `'draft'`), resetting the model and focus. */
  sessionKey: string;
  disabled?: boolean;
  onSend(text: string, model: ModelEntry, reasoningEffort: string): void | Promise<void>;
  injectedText?: { text: string; nonce: number };
}

/** Bottom composer with model and effort pickers and a send-only button. */
export function Composer({ models, turns, sessionKey, disabled = false, onSend, injectedText }: ComposerProps) {
  const [text, setText] = useState(() => readDraft(sessionKey));
  const [modelId, setModelId] = useState('');
  const [effort, setEffort] = useState('');
  const [sending, setSending] = useState(false);
  const [exceeded, setExceeded] = useState(false);
  const inputTokens = useInputTokenCount(text);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  const textRef = useRef(text);
  textRef.current = text;
  const sessionKeyRef = useRef(sessionKey);
  sessionKeyRef.current = sessionKey;

  // New-session model/effort defaults and the submit key come from the shared
  // Desktop preferences; the composer only reads them.
  const preferences = useQuery(preferencesQuery);
  const sessionPrefs = preferences.data?.session;
  const prefsReady = sessionPrefs !== undefined;
  const prefs = sessionPrefs ?? DEFAULT_SESSION_PREFS;

  // One-time migration of the pre-bridge localStorage "last sent" value.
  const migrated = useRef(false);
  useEffect(() => {
    if (!prefsReady || migrated.current) return;
    migrated.current = true;
    const legacy = readLegacyLastSent();
    if (legacy === undefined) return;
    const writes: Promise<unknown>[] = [];
    if (legacy.model !== '' && sessionPrefs.lastSentModel === null) {
      writes.push(shell.setPreference('session.lastSentModel', legacy.model));
    }
    if (legacy.effort !== '' && sessionPrefs.lastSentEffort === null) {
      writes.push(shell.setPreference('session.lastSentEffort', legacy.effort));
    }
    void Promise.all(writes).then(clearLegacyLastSent).catch(() => {
      migrated.current = false;
    });
  }, [prefsReady, sessionPrefs]);

  useEffect(() => {
    const last = turnsRef.current[turnsRef.current.length - 1];
    // An existing session keeps its model immutable; only a new session reads
    // the default-model preference.
    if (last !== undefined) {
      const match = models.find((entry) => entry.publicId === `${last.model.provider}/${last.model.model}`) ?? models[0];
      setModelId(match?.publicId ?? '');
      // An existing session's model and effort are authoritative and never change.
      setEffort(last.model.reasoningEffort ?? '');
      textareaRef.current?.focus();
      return;
    }
    const specified = prefs.defaultModel === 'specified';
    const wanted = specified ? prefs.model : prefs.lastSentModel;
    const storedEffort = specified ? prefs.effort : prefs.lastSentEffort;
    const match = (wanted === null ? undefined : models.find((entry) => entry.publicId === wanted)) ?? models[0];
    setModelId(match?.publicId ?? '');
    setEffort(supportedEffort(match, storedEffort ?? ''));
    textareaRef.current?.focus();
  }, [sessionKey, models, turns.at(-1)?.id, prefsReady]);

  // Load the destination draft on switch/remount and flush the outgoing one so
  // no pending edit is lost.
  useEffect(() => {
    setText(readDraft(sessionKey));
    return () => { flushDraft(sessionKey); };
  }, [sessionKey]);

  useEffect(() => {
    if (!injectedText) return;
    setText(injectedText.text);
    writeDraft(sessionKey, injectedText.text);
    textareaRef.current?.focus();
  }, [injectedText?.nonce]);

  // Publish the destination model and text so the usage meter (and the
  // inspector's model list) read the composer's current selection.
  useEffect(() => {
    publishComposerState({ sessionKey, modelId, inputText: text });
  }, [sessionKey, modelId, text]);

  // The inspector's "use this model" action requests a switch for the active
  // session only; a request for another session is ignored. The reasoning
  // effort is kept only when the target model still supports it.
  useEffect(() => onSessionModelRequest((request) => {
    if (request.sessionKey !== sessionKey) return;
    const target = models.find((entry) => entry.publicId === request.modelId);
    setModelId(request.modelId);
    setEffort((current) => supportedEffort(target, current));
  }), [sessionKey, models]);

  const selected = models.find((entry) => entry.publicId === modelId);
  const options: ModelOption[] = models.map((entry) => ({
    value: entry.publicId,
    label: entry.displayName,
    group: entry.provider,
  }));

  const handleChange = (value: string): void => {
    setText(value);
    writeDraft(sessionKey, value);
  };

  const selectModel = (value: string): void => {
    const target = models.find((entry) => entry.publicId === value);
    setModelId(value);
    setEffort((current) => supportedEffort(target, current));
  };

  const submit = (): void => {
    const body = text.trim();
    if (body === '' || !selected || sending || disabled || exceeded) return;
    const originKey = sessionKey;
    const bodyText = text;
    setSending(true);
    void Promise.resolve(onSend(body, selected, effort))
      .then(
        () => {
          // Clear the sent draft, but never a destination the user switched to
          // while the send was in flight.
          if (sessionKeyRef.current !== originKey || textRef.current === bodyText) {
            clearDraft(originKey);
            if (sessionKeyRef.current === originKey) setText('');
          }
          // Remember the successful send for the "沿用上次发送的模型" default.
          void shell.setPreference('session.lastSentModel', selected.publicId).catch(() => undefined);
          void shell.setPreference('session.lastSentEffort', effort === '' ? null : effort).catch(() => undefined);
        },
        () => {
          // A rejected send keeps the draft so the user can retry.
        },
      )
      .finally(() => {
        setSending(false);
      });
  };

  return (
    <PromptInput
      value={text}
      onValueChange={handleChange}
      onSubmit={submit}
      disabled={disabled || !selected}
      submitDisabled={sending || exceeded}
      sendKey={sessionPrefs?.sendKey ?? 'enter'}
      textareaRef={textareaRef}
      placeholder="输入消息，可随时发起新的并行轮次"
      toolbar={
        <>
          <ModelPicker models={options} value={modelId} onChange={selectModel} disabled={models.length === 0} />
          <EffortPicker levels={selected?.thinkingLevels ?? []} value={effort} onChange={setEffort} />
        </>
      }
      toolbarTrailing={
        <ContextMeter
          sessionKey={sessionKey}
          modelId={modelId}
          {...(inputTokens === undefined ? {} : { inputTokens })}
          onBudgetChange={setExceeded}
        />
      }
    />
  );
}
