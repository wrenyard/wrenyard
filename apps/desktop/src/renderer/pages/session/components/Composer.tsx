import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { REASONING_EFFORTS } from '@wrenyard/models';
import { AlertTriangle, Plus, X } from 'lucide-react';
import { countInputTokens } from '../model/usage.js';
import { ModelPicker, modelBadges, type ModelOption } from '@/renderer/components/chat/model-picker';
import { PromptInput } from '@/renderer/components/chat/prompt-input';
import { InputGroupButton } from '@/renderer/components/ui/input-group';
import { getSessionBridge } from '@/renderer/lib/session';
import { preferencesQuery } from '@/renderer/lib/queries';
import type { DraftAttachment, ModelEntry, TurnModel } from '../model/types.js';
import { readFirstRequest, retainReasoningEffort, writeFirstRequest, type ReasoningEffort } from '../state/reasoning-effort.js';
import { useComposerSelection, useSessionUsage } from '../state/session-usage.js';
import { clearDraftAttachments, isStagedPathRetained, readDraftAttachments, reconcileSentDraft } from '../state/drafts.js';
import { useContextBudget } from '../state/use-context-budget.js';
import { MediaAttachments, fromDraftAttachment } from './MediaAttachments.js';

/** Input text is token-counted 300ms after typing stops (usage spec 3.3). */
const INPUT_TOKEN_DEBOUNCE_MS = 300;

/**
 * Debounced `o200k_base` count of the composer text, including a paste. The
 * first count is `undefined`, which the shared budget treats as zero.
 */
function useInputTokenCount(text: string): number | undefined {
  const [tokens, setTokens] = useState<number | undefined>(undefined);
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        setTokens(countInputTokens(text));
      } catch {
        // Token counting is best-effort; fall back to zero.
      }
    }, INPUT_TOKEN_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);
  return tokens;
}

/** Upper bound on attachments held by the composer in one draft. */
const MAX_ATTACHMENTS = 32;

/** Providers whose route health is pool-scoped and therefore gate selection. */
const ROUTE_GATED_PROVIDERS = new Set(['openrouter', 'opencode-zen', 'opencode-go']);

/** Marker appended to a probe-eligible option: a retry, never confirmed health. */
const RETRY_MARKER = '（可重试，待确认恢复）';

/**
 * The session request runner's `isCallableNow` rule for one picker row: unknown,
 * healthy and non-gated routes are callable; an open route is not; a half-open
 * route only once its bounded recovery probe is due — a not-yet-due probe, or an
 * active probe lease, keeps it blocked. This predicate is independent of the
 * model-list/mainstream filter and composes with it by simple conjunction. It
 * takes one argument and reads the clock itself, so it is never handed an array
 * index as a timestamp by an accidental direct `filter`/`find` reference.
 */
function isRouteCallable(entry: ModelEntry): boolean {
  if (!ROUTE_GATED_PROVIDERS.has(entry.provider) || entry.routeState === undefined) return true;
  if (entry.routePhase === 'open') return false;
  if (entry.routeNextProbeAt === undefined) return true;
  return Date.parse(entry.routeNextProbeAt) <= Date.now();
}

/** A gated route with a known fault whose probe is due: offered only as an explicit retry. */
function isProbeEligible(entry: ModelEntry): boolean {
  return ROUTE_GATED_PROVIDERS.has(entry.provider)
    && entry.routeState !== undefined
    && isRouteCallable(entry);
}

/** Blocked-route label in the shared session-status vocabulary; free quota, paid balance and OpenCode Go plans differ. */
function routeUnavailableLabel(entry: ModelEntry): string {
  switch (entry.routeState) {
    case 'rate_limited': return '限流';
    case 'quota_exhausted':
      if (entry.free === true) return '免费额度耗尽';
      if (entry.provider === 'opencode-go') return '套餐额度耗尽';
      if (entry.provider === 'openrouter' || entry.provider === 'opencode-zen') return '付费余额耗尽';
      return '额度耗尽';
    case 'auth_failed': return '认证失败';
    case 'model_unavailable': return '模型不可用';
    default: return '不可用';
  }
}

/**
 * Whether this renderer's document is currently visible. A standard window
 * hidden behind a mini card reports `hidden`; only the surface the user is
 * actually looking at may request or hold a suggestion.
 */
function useSurfaceVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  useEffect(() => {
    const onVisibility = (): void => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);
  return visible;
}

export interface ComposerProps {
  models: ModelEntry[];
  turns: TurnModel[];
  /** Changes on session switch (or `'draft'`), resetting the model. */
  sessionKey: string;
  disabled?: boolean;
  onSend(text: string, model: ModelEntry, reasoningEffort: ReasoningEffort, attachments: DraftAttachment[]): void | Promise<void>;
  injectedText?: { text: string; attachments?: DraftAttachment[]; nonce: number };
  /** Bumped to request an explicit input focus (e.g. the new-conversation shortcut). */
  focusRequest?: number;
  /** Invoked after an explicit focus request has been consumed. */
  onFocusRequestHandled?: () => void;
  /** Quote of the message being replied to. */
  reply?: string | undefined;
  onCancelReply?: () => void;
}

/** Bottom composer with a unified model/effort picker, attachments and a send button. */
export function Composer({ models, turns, sessionKey, disabled = false, onSend, injectedText, focusRequest = 0, onFocusRequestHandled, reply, onCancelReply }: ComposerProps) {
  const {
    modelId, setModelId, effort, setEffort, text, setText, clearText,
    attachments, setAttachments, clearAttachments,
    suggestion, setSuggestionEligible, acceptSuggestion, dismissSuggestion,
  } = useComposerSelection();
  const [sending, setSending] = useState(false);
  const [attachmentError, setAttachmentError] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const inputTokens = useInputTokenCount(text);
  const { setInputTokens } = useSessionUsage();
  const { budget } = useContextBudget(sessionKey, modelId, inputTokens);
  const exceeded = budget?.exceeded ?? false;
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
  /**
   * A synchronous latch around one submit. The `sending` state only updates on
   * the next render, so two clicks (or key repeats) in the same tick could both
   * pass the guard and start two turns during an active recovery. The ref flips
   * before any async send work and is released when the send settles.
   */
  const submitLatch = useRef(false);

  // Publish the debounced input count so the status-bar context item counts the
  // draft text too; reset to zero when the composer unmounts.
  useEffect(() => () => setInputTokens(0), [setInputTokens]);
  useEffect(() => {
    setInputTokens(inputTokens ?? 0);
  }, [inputTokens, setInputTokens]);

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

  // The composer owns the local eligibility rule (empty, no attachments, no
  // reply, not sending, feature on, this surface visible); the state layer owns
  // when a request is made. Focus is deliberately not part of the rule: a
  // completed turn still shows the ghost text without re-focusing the field.
  const surfaceVisible = useSurfaceVisible();
  const promptCompletionEnabled = preferences.data?.session.promptCompletion === true;
  const suggestionEligible = promptCompletionEnabled && !disabled && !sending && surfaceVisible
    && reply === undefined && text === '' && attachments.length === 0
    && !turns.some((turn) => turn.status === 'running');
  // Publish the current render's eligibility synchronously, so a turn that
  // completes in this very commit is judged on today's value rather than the
  // one captured while it was still running.
  setSuggestionEligible(suggestionEligible);
  // Becoming ineligible (typing, attaching, replying, a disabled field or a new
  // running turn) drops the shown suggestion and cancels any in-flight request.
  useEffect(() => {
    if (!suggestionEligible) dismissSuggestion();
  }, [suggestionEligible, dismissSuggestion]);

  // Seed the model/effort once per session (or per new turn). A nonempty
  // remembered or explicit pick is never overwritten by an availability
  // refresh; an as-yet UNSELECTED draft keeps re-seeding until a selectable
  // model appears.
  const seedKey = `${sessionKey}\u0000${turns.at(-1)?.id ?? ''}`;
  const seeded = useRef('');
  useEffect(() => {
    const modelsLoaded = models.length > 0;
    if (seeded.current === seedKey && (!modelsLoaded || modelId !== '')) return;
    seeded.current = seedKey;
    const last = turnsRef.current[turnsRef.current.length - 1];
    // An existing session's model is authoritative; it is kept even when its
    // route is blocked or a filter dropped it, never silently replaced. Its
    // effort is kept when the route still supports it, else resolved by the
    // shared nearest rule.
    if (last !== undefined) {
      const publicId = `${last.model.provider}/${last.model.model}`;
      const supported = models.find((entry) => entry.publicId === publicId)?.reasoningEfforts ?? [];
      setModelId(publicId);
      // Normalize the stored effort to a valid level: kept when valid, else the
      // default. A missing catalog row falls back to the full effort ladder.
      setEffort(retainReasoningEffort(last.model.reasoningEffort, supported.length > 0 ? supported : REASONING_EFFORTS));
      return;
    }
    // A brand-new session inherits the previous session's FIRST request model
    // and effort verbatim, even when the catalog dropped it or its route is
    // blocked — it is never replaced by another model. Missing a catalog row,
    // the remembered effort is kept as recorded.
    const first = readFirstRequest();
    if (first !== undefined) {
      const supported = models.find((entry) => entry.publicId === first.model)?.reasoningEfforts ?? [];
      setModelId(first.model);
      setEffort(supported.length > 0 ? retainReasoningEffort(first.effort, supported) : first.effort);
      return;
    }
    // No remembered selection: start at the first selectable model, which may
    // only appear after a later availability refresh.
    const fallback = models.find((entry) => isRouteCallable(entry));
    if (fallback === undefined) {
      setModelId('');
      return;
    }
    setModelId(fallback.publicId);
    if (fallback.reasoningEfforts.length > 0) setEffort(retainReasoningEffort(undefined, fallback.reasoningEfforts));
  }, [seedKey, models, modelId]);

  useEffect(() => {
    if (!injectedText) return;
    setText(injectedText.text);
    if (injectedText.attachments !== undefined) setAttachments(injectedText.attachments);
    textareaRef.current?.focus();
  }, [injectedText?.nonce]);

  // The catalog entry behind the current selection, when a filter has not
  // removed it, and whether that selection is usable right now.
  const selected = models.find((entry) => entry.publicId === modelId);
  const selectionUsable = selected !== undefined && isRouteCallable(selected);
  const selectionUnusable = modelId !== '' && !selectionUsable;

  // An explicit focus request is one-shot: it is served only once the textarea
  // is actually ready (mounted, enabled and carrying a selected model), then
  // consumed so later disabled/model refreshes cannot reuse it. A layout effect
  // commits the focus before paint once the input mounts.
  useLayoutEffect(() => {
    if (focusRequest <= 0) return;
    if (disabled || !selected) return;
    textareaRef.current?.focus({ preventScroll: true });
    onFocusRequestHandled?.();
  }, [focusRequest, disabled, selected, onFocusRequestHandled]);

  // The model entry always rides the composer toolbar: next to the typed text in
  // the compact row, and on the toolbar's left in the expanded layout.
  // Callable routes are offered; a probe-eligible route is labelled as a retry.
  const options: ModelOption[] = models
    .filter((entry) => isRouteCallable(entry))
    .map((entry) => ({
      value: entry.publicId,
      label: isProbeEligible(entry) ? entry.displayName + RETRY_MARKER : entry.displayName,
      group: entry.providerDisplayName,
      badges: modelBadges(entry),
      efforts: entry.reasoningEfforts,
      defaultEffort: entry.reasoningEfforts.length === 0 ? effort : retainReasoningEffort(effort, entry.reasoningEfforts),
    }));
  // An unusable selection is named on the trigger (never silently becoming
  // another model) and blocks sending; a probe-eligible one is informational.
  const selectionPlaceholder = selectionUnusable ? (selected?.displayName ?? modelId) : '选择模型';
  const selectionWarning = selected === undefined
    ? '所选模型已不在可用列表'
    : `所选模型不可用：${routeUnavailableLabel(selected)}`;
  const selectionRetry = selected !== undefined && isProbeEligible(selected)
    ? `所选模型${routeUnavailableLabel(selected)}，发送将以重试确认恢复`
    : '';

  const handleChange = (value: string): void => {
    // Typing or pasting text replaces and discards any suggestion.
    if (value !== '') dismissSuggestion();
    setText(value);
  };

  const selectModel = (nextModelId: string, nextEffort: ReasoningEffort): void => {
    setModelId(nextModelId);
    setEffort(nextEffort);
  };

  const submit = (): void => {
    if (submitLatch.current) return;
    // Latch synchronously at the very start, before any async work, so a second
    // click or key repeat in the same tick cannot start a second turn while a
    // turn is recovering. Every early exit and throw path releases it.
    submitLatch.current = true;
    const body = text.trim();
    const submitted = attachmentsRef.current;
    if ((body === '' && submitted.length === 0) || !selected || sending || disabled || exceeded || selectionUnusable) {
      submitLatch.current = false;
      return;
    }
    // A send discards the suggestion and cancels any in-flight request.
    dismissSuggestion();
    const originKey = sessionKey;
    const bodyText = text;
    const submittedIds = submitted.map((item) => item.id);
    // Capture whether this is the session's first request *before* the send or
    // any optimistic turn is added, so a successful completion records the first
    // request even though the model list has already changed by then.
    const firstInSession = turnsRef.current.length === 0;
    setSending(true);
    // Call `onSend` inside the chain so a synchronous throw becomes a
    // rejection and the latch is always released.
    void Promise.resolve()
      .then(() => onSend(body, selected, effort, submitted))
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
          // Only a session's first request is remembered for the next new session.
          if (firstInSession) writeFirstRequest({ model: selected.publicId, effort });
        },
        () => {
          // A rejected send keeps the text and every attachment so the user can retry.
        },
      )
      .finally(() => {
        submitLatch.current = false;
        setSending(false);
      });
  };

  const attachmentStrip = attachmentError === '' && attachments.length === 0 && reply === undefined ? undefined : (
    <div className="flex flex-col gap-1.5">
      {reply !== undefined && (
        <div className="flex items-center gap-2 rounded-lg bg-muted px-2 py-1 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">回复：{reply}</span>
          <InputGroupButton type="button" size="icon-xs" aria-label="取消回复" onClick={onCancelReply}>
            <X />
          </InputGroupButton>
        </div>
      )}
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
        submitDisabled={sending || exceeded || selectionUnusable}
        sendKey={preferences.data?.session.sendKey ?? 'enter'}
        textareaRef={textareaRef}
        placeholder="输入消息…"
        className="@container/composer"
        attachments={attachmentStrip}
        hasAttachments={attachments.length > 0}
        onPaste={handlePaste}
        suggestion={suggestion}
        onAcceptSuggestion={acceptSuggestion}
        onDismissSuggestion={dismissSuggestion}
        toolbar={
          <>
            {/* Always mounted: the compact pill sits next to the text, and the
                expanded layout puts it on the toolbar's left. Its compact
                trigger collapses to an icon below the composer container width
                without ever truncating the model name. */}
            <ModelPicker
              models={options}
              value={modelId}
              effort={effort}
              onChange={selectModel}
              disabled={options.length === 0}
              placeholder={selectionPlaceholder}
              className="min-w-0 max-w-full min-h-6 py-0.5"
              compactTrigger
            />
            {selectionUnusable && (
              <span className="flex items-center gap-1 text-xs text-destructive" role="status">
                <AlertTriangle className="size-3.5 shrink-0" />
                {selectionWarning}
              </span>
            )}
            {selectionRetry !== '' && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground" role="status">
                <AlertTriangle className="size-3.5 shrink-0" />
                {selectionRetry}
              </span>
            )}
            {exceeded && (
              <span className="flex items-center gap-1 text-xs text-destructive" role="status">
                <AlertTriangle className="size-3.5 shrink-0" />
                超出上下文
              </span>
            )}
          </>
        }
        toolbarLeading={
          <InputGroupButton
            type="button"
            size="icon-sm"
            className="size-6 rounded-full bg-muted p-0 text-muted-foreground hover:bg-muted/80 hover:text-foreground [&_svg]:size-3.5"
            aria-label="添加附件"
            title="添加附件"
            disabled={disabled || attachments.length >= MAX_ATTACHMENTS}
            onClick={() => { void chooseFiles(); }}
          >
            <Plus />
          </InputGroupButton>
        }
      />
    </div>
  );
}
