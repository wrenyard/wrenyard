import { useEffect, useRef, useState } from 'react';
import { countInputTokens } from '../model/usage.js';
import { EffortPicker, ModelPicker, type ModelOption } from '@/renderer/components/chat/model-picker';
import { PromptInput } from '@/renderer/components/chat/prompt-input';
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

const LAST_SENT_KEY = 'session:last-sent';

interface LastSent {
  model: string;
  effort: string;
}

function readLastSent(): LastSent | undefined {
  try {
    const raw = window.localStorage.getItem(LAST_SENT_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<LastSent>;
    return { model: parsed.model ?? '', effort: parsed.effort ?? '' };
  } catch {
    return undefined;
  }
}

function writeLastSent(value: LastSent): void {
  try {
    window.localStorage.setItem(LAST_SENT_KEY, JSON.stringify(value));
  } catch {
    // Persisting the preference is best-effort.
  }
}

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

  useEffect(() => {
    const last = turnsRef.current[turnsRef.current.length - 1];
    const stored = readLastSent();
    const wanted = last ? `${last.model.provider}/${last.model.model}` : stored?.model;
    const match = models.find((entry) => entry.publicId === wanted) ?? models[0];
    setModelId(match?.publicId ?? '');
    setEffort(last ? last.model.reasoningEffort ?? '' : stored?.effort ?? '');
    textareaRef.current?.focus();
  }, [sessionKey, models, turns.at(-1)?.id]);

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
  // session only; a request for another session is ignored.
  useEffect(() => onSessionModelRequest((request) => {
    if (request.sessionKey !== sessionKey) return;
    setModelId(request.modelId);
  }), [sessionKey]);

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
        },
        () => {
          // A rejected send keeps the draft so the user can retry.
        },
      )
      .finally(() => {
        setSending(false);
        writeLastSent({ model: selected.publicId, effort });
      });
  };

  return (
    <PromptInput
      value={text}
      onValueChange={handleChange}
      onSubmit={submit}
      disabled={disabled || !selected}
      submitDisabled={sending || exceeded}
      textareaRef={textareaRef}
      placeholder="输入消息，可随时发起新的并行轮次"
      toolbar={
        <>
          <ModelPicker models={options} value={modelId} onChange={setModelId} disabled={models.length === 0} />
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
