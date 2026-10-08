import { useEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { countInputTokens } from '../model/usage.js';
import { EffortPicker, ModelPicker, modelBadges, modelRuntimeDescription, type ModelOption } from '@/renderer/components/chat/model-picker';
import { PromptInput } from '@/renderer/components/chat/prompt-input';
import { InputGroupButton } from '@/renderer/components/ui/input-group';
import { getSessionBridge } from '@/renderer/lib/session';
import { preferencesQuery } from '@/renderer/lib/queries';
import type { DraftAttachment, ModelEntry, TurnModel } from '../model/types.js';
import {
  firstRequestAfterSend,
  initialReasoningEffort,
  readFirstRequest,
  retainReasoningEffort,
  writeFirstRequest,
  type ReasoningEffort,
} from '../state/reasoning-effort.js';
import { useComposerSelection } from '../state/session-usage.js';
import { clearDraftAttachments, isStagedPathRetained, readDraftAttachments, reconcileSentDraft } from '../state/drafts.js';
import { ContextMeter } from './usage/ContextMeter.js';
import { MediaAttachments, fromDraftAttachment } from './MediaAttachments.js';

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

/** Upper bound on attachments held by the composer in one draft. */
const MAX_ATTACHMENTS = 32;

export interface ComposerProps {
  models: ModelEntry[];
  turns: TurnModel[];
  /** Changes on session switch (or `'draft'`), resetting the model and focus. */
  sessionKey: string;
  disabled?: boolean;
  onSend(text: string, model: ModelEntry, reasoningEffort: ReasoningEffort, attachments: DraftAttachment[]): void | Promise<void>;
  injectedText?: { text: string; attachments?: DraftAttachment[]; nonce: number };
}

/** Bottom composer with model and effort pickers, attachments and a send button. */
export function Composer({ models, turns, sessionKey, disabled = false, onSend, injectedText }: ComposerProps) {
  const {
    modelId, setModelId, effort, setEffort, text, setText, clearText,
    attachments, setAttachments, clearAttachments,
  } = useComposerSelection();
  const [sending, setSending] = useState(false);
  const [exceeded, setExceeded] = useState(false);
  const [attachmentError, setAttachmentError] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const inputTokens = useInputTokenCount(text);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  const textRef = useRef(text);
  textRef.current = text;
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const sessionKeyRef = useRef(sessionKey);
  sessionKeyRef.current = sessionKey;
  const dragDepth = useRef(0);

  const appendAttachments = (incoming: DraftAttachment[]): void => {
    if (incoming.length === 0) return;
    const current = attachmentsRef.current;
    const seen = new Set(current.map((item) => item.id));
    const next = [...current];
    for (const item of incoming) {
      if (next.length >= MAX_ATTACHMENTS) break;
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      next.push(item);
    }
    attachmentsRef.current = next;
    setAttachments(next);
  };

  const chooseFiles = async (): Promise<void> => {
    setAttachmentError('');
    try {
      appendAttachments(await getSessionBridge().selectAttachments());
    } catch {
      setAttachmentError('选择文件失败');
    }
  };

  const removeAttachment = (id: string): void => {
    const removed = attachmentsRef.current.find((item) => item.id === id);
    setAttachments(attachmentsRef.current.filter((item) => item.id !== id));
    if (removed?.staged === true) {
      void getSessionBridge().discardDraftAttachments([removed]).catch(() => undefined);
    }
  };

  // Drag files from the OS anywhere over the window; paths come from Electron
  // `webUtils` in the preload (the renderer never reads the filesystem).
  useEffect(() => {
    const onDragOver = (event: DragEvent): void => {
      if (event.dataTransfer === null || ![...event.dataTransfer.types].includes('Files')) return;
      event.preventDefault();
      setDragActive(true);
    };
    const onDragLeave = (): void => {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragActive(false);
    };
    const onDrop = (event: DragEvent): void => {
      dragDepth.current = 0;
      setDragActive(false);
      const files = event.dataTransfer?.files;
      if (files === undefined || files.length === 0) return;
      event.preventDefault();
      setAttachmentError('');
      const bridge = getSessionBridge();
      const paths: string[] = [];
      for (const file of files) {
        try {
          const path = bridge.pathForFile(file);
          if (path !== '') paths.push(path);
        } catch {
          // A file without an OS path (e.g. a browser-generated blob) is skipped.
        }
      }
      if (paths.length === 0) {
        setAttachmentError('无法获取拖入文件的路径');
        return;
      }
      void bridge.describeAttachments(paths).then(appendAttachments).catch(() => setAttachmentError('读取文件失败'));
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  const handlePaste = (event: ReactClipboardEvent<HTMLTextAreaElement>): void => {
    const items = event.clipboardData?.items;
    if (items === undefined) return;
    const image = [...items].find((item) => item.type.startsWith('image/'));
    if (image === undefined) return;
    event.preventDefault();
    const file = image.getAsFile();
    if (file === null) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      if (dataUrl === '') return;
      setAttachmentError('');
      void getSessionBridge().stageClipboardImage({ dataUrl, ...(file.name ? { name: file.name } : {}) })
        .then((draft) => appendAttachments([draft]))
        .catch(() => setAttachmentError('粘贴图片失败'));
    };
    reader.onerror = () => setAttachmentError('读取剪贴板图片失败');
    reader.readAsDataURL(file);
  };

  // The submit key still comes from the shared Desktop preferences; the model
  // and effort of a new session come from the client-local first-request record.
  const preferences = useQuery(preferencesQuery);

  useEffect(() => {
    const last = turnsRef.current[turnsRef.current.length - 1];
    // An existing session's model is authoritative; its effort is kept when the
    // route still supports it, else resolved by the shared nearest rule.
    if (last !== undefined) {
      const match = models.find((entry) => entry.publicId === `${last.model.provider}/${last.model.model}`) ?? models[0];
      setModelId(match?.publicId ?? '');
      const supported = match?.reasoningEfforts ?? [];
      if (supported.length > 0) setEffort(retainReasoningEffort(last.model.reasoningEffort, supported));
      textareaRef.current?.focus();
      return;
    }
    // A brand-new session inherits the previous session's FIRST request model
    // and effort (Desktop local state only); absent a match it starts at medium.
    const first = readFirstRequest();
    const inherited = first === undefined ? undefined : models.find((entry) => entry.publicId === first.model);
    const match = inherited ?? models[0];
    setModelId(match?.publicId ?? '');
    const supported = match?.reasoningEfforts ?? [];
    if (supported.length > 0) {
      setEffort(inherited !== undefined && first !== undefined
        ? retainReasoningEffort(first.effort, supported)
        : initialReasoningEffort(supported));
    }
    textareaRef.current?.focus();
  }, [sessionKey, models, turns.at(-1)?.id]);

  useEffect(() => {
    if (!injectedText) return;
    setText(injectedText.text);
    if (injectedText.attachments !== undefined) setAttachments(injectedText.attachments);
    textareaRef.current?.focus();
  }, [injectedText?.nonce]);

  const selected = models.find((entry) => entry.publicId === modelId);
  const options: ModelOption[] = models.map((entry) => ({
    value: entry.publicId,
    label: entry.displayName,
    group: entry.providerDisplayName,
    description: modelRuntimeDescription(entry.runtime),
    badges: modelBadges(entry),
  }));

  const handleChange = (value: string): void => {
    setText(value);
  };

  const selectModel = (value: string): void => {
    const target = models.find((entry) => entry.publicId === value);
    setModelId(value);
    const supported = target?.reasoningEfforts ?? [];
    if (supported.length === 0) return;
    setEffort((current) => retainReasoningEffort(current, supported));
  };

  const submit = (): void => {
    const body = text.trim();
    const submitted = attachmentsRef.current;
    if ((body === '' && submitted.length === 0) || !selected || sending || disabled || exceeded) return;
    const originKey = sessionKey;
    const bodyText = text;
    const submittedIds = submitted.map((item) => item.id);
    // Capture whether this is the session's first request *before* the send or
    // any optimistic turn is added, so a successful completion records the first
    // request even though the model list has already changed by then.
    const firstInSession = turnsRef.current.length === 0;
    setSending(true);
    void Promise.resolve(onSend(body, selected, effort, submitted))
      .then(
        () => {
          // Clear the sent draft (and only the sent one) independently for text
          // and attachments, so a newer edit — or a destination session the user
          // switched to — is never discarded mid-flight.
          const active = attachmentsRef.current;
          const reconciliation = reconcileSentDraft({
            originKey,
            activeKey: sessionKeyRef.current,
            bodyText,
            activeText: textRef.current,
            submittedIds,
            activeIds: active.map((item) => item.id),
            originIds: readDraftAttachments(originKey).map((item) => item.id),
          });
          if (reconciliation.clearText) clearText();
          if (reconciliation.clearAttachments) clearAttachments();
          else if (reconciliation.clearOriginAttachments) clearDraftAttachments(originKey);
          // Main owns staged clipboard files; release each one only once no
          // retained draft still references it (e.g. a newer attachment list).
          const releasable = submitted.filter(
            (item) => item.staged === true && item.path !== undefined && !isStagedPathRetained(item.path),
          );
          if (releasable.length > 0) {
            void getSessionBridge().discardDraftAttachments(releasable).catch(() => undefined);
          }
          // Remember a session's FIRST request (model + effort) in Desktop local
          // state so a later new session can inherit it. A request after the
          // first in the same session never overwrites that record.
          const record = firstRequestAfterSend(
            readFirstRequest(),
            { model: selected.publicId, effort },
            !firstInSession,
          );
          if (record !== undefined) writeFirstRequest(record);
        },
        () => {
          // A rejected send keeps the text and every attachment so the user can retry.
        },
      )
      .finally(() => {
        setSending(false);
      });
  };

  const attachmentStrip = attachmentError === '' && attachments.length === 0 ? undefined : (
    <div className="flex flex-col gap-1.5">
      {attachmentError !== '' && <p className="text-xs text-destructive">{attachmentError}</p>}
      {attachments.length > 0 && (
        <MediaAttachments
          items={attachments.map(fromDraftAttachment)}
          onRemove={removeAttachment}
        />
      )}
    </div>
  );

  return (
    <div className="relative">
      {dragActive && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/60 bg-background/70 text-sm font-medium text-primary">
          松开以添加文件
        </div>
      )}
      <PromptInput
        value={text}
        onValueChange={handleChange}
        onSubmit={submit}
        disabled={disabled || !selected}
        submitDisabled={sending || exceeded}
        sendKey={preferences.data?.session.sendKey ?? 'enter'}
        textareaRef={textareaRef}
        placeholder="输入消息，可随时发起新的并行轮次"
        attachments={attachmentStrip}
        hasAttachments={attachments.length > 0}
        onPaste={handlePaste}
        toolbar={
          <>
            <InputGroupButton
              type="button"
              size="icon-sm"
              aria-label="添加附件"
              title="添加附件"
              disabled={disabled || attachments.length >= MAX_ATTACHMENTS}
              onClick={() => { void chooseFiles(); }}
            >
              <Plus />
            </InputGroupButton>
            <ModelPicker models={options} value={modelId} onChange={selectModel} disabled={models.length === 0} />
            <EffortPicker levels={selected?.reasoningEfforts ?? []} value={effort} onChange={setEffort} />
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
    </div>
  );
}
