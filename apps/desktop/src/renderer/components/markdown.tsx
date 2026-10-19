import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { Streamdown, defaultRehypePlugins, type Components, type ExtraProps, type PluginConfig } from 'streamdown';
import { code } from '@streamdown/code';
import { cjk } from '@streamdown/cjk';
import { FileText } from 'lucide-react';
import { cn } from 'cn';
import {
  attachmentRefUrl,
  isAttachmentRefHost,
  parseAttachmentRefUrl,
  type SessionFile,
} from '@wrenyard/protocol';
import { openLightbox, useLightboxItem } from '@/renderer/components/lightbox-store';
import {
  MermaidBlock,
  MermaidDarkContext,
} from '@/renderer/components/mermaid-renderer';

/**
 * Loaded on demand: the todo link pulls in the shell preload facade, which the
 * pet windows do not expose. Documents without todo ids (the pet panels) never
 * import it, so this module keeps loading without shell side effects.
 */
const TodoLink = lazy(() =>
  import('@/renderer/components/todo-link').then((module) => ({ default: module.TodoLink })));

const PLUGINS: PluginConfig = {
  code,
  cjk,
  // Custom fenced renderers are consulted before Shiki and before Streamdown's
  // built-in Mermaid branch, so only a `mermaid` fence leaves Shiki untouched.
  // The component reference is module-level and stable, so streaming re-renders
  // never remount it.
  renderers: [{ language: 'mermaid', component: MermaidBlock }],
};

/** Shiki theme per appearance mode; `github-dark-default` matches the dark tokens. */
const SHIKI_THEME = { light: 'github-light', dark: 'github-dark-default' } as const;

type OpenExternal = (href: string) => void;

/** Reads one image attachment preview; the embedder binds the session media read. */
type ReadAttachment = (file: SessionFile) => Promise<string | undefined>;

/** Reveals one attachment in the OS file manager; the embedder binds the session bridge. */
type RevealAttachment = (file: SessionFile) => void;

/** The rehype plugin list Streamdown accepts, read off its own prop contract. */
type RehypePlugins = NonNullable<ComponentProps<typeof Streamdown>['rehypePlugins']>;

/** Identity of one attachment entry; both canonical path and hash participate. */
export function attachmentFileIdentity(file: Pick<SessionFile, 'path' | 'hash'>): string {
  return `${file.path}\u0000${file.hash}`;
}

function MarkdownLink({
  href,
  children,
  onClick,
  onOpenExternal,
  ...rest
}: ComponentProps<'a'> & { onOpenExternal?: OpenExternal }) {
  return (
    <a
      {...rest}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || !href) return;
        event.preventDefault();
        onOpenExternal?.(href);
      }}
    >
      {children}
    </a>
  );
}

/**
 * The per-message attachment directory and lookups. Everything is derived once
 * from the supplied directory: only an exact reference URL that also exists in
 * the directory resolves, and no filesystem-path heuristic is ever applied.
 */
interface AttachmentContext {
  /** Directory keyed by identity: only these exact references resolve. */
  files: ReadonlyMap<string, SessionFile>;
  read: ReadAttachment | undefined;
  reveal: RevealAttachment | undefined;
  /** Session owning the files; enables the lightbox's original image and file actions. */
  sessionId?: string;
}

/** The shared empty context: a message without attachments is always a no-op. */
const EMPTY_ATTACHMENT_CONTEXT: AttachmentContext = {
  files: new Map(),
  read: undefined,
  reveal: undefined,
};

/** The current message's directory, read by the parsed anchor / image hooks. */
const AttachmentDirectory = createContext<AttachmentContext>(EMPTY_ATTACHMENT_CONTEXT);

/**
 * Build the per-message directory from the task files the session produced.
 * The identity map is all the render path needs: which reference is the rich
 * one is decided by document order in the AST transformer below, never by a
 * source-text search, so references inside code, escaped text or nested labels
 * are never mistaken for a real link.
 */
function buildAttachmentDirectory(
  attachments: readonly SessionFile[],
  read: ReadAttachment | undefined,
  reveal: RevealAttachment | undefined,
  sessionId: string | undefined,
): AttachmentContext {
  const files = new Map<string, SessionFile>();
  for (const file of attachments) {
    // Only Task outputs are citable here; user uploads keep their own components.
    if (file.source !== 'task') continue;
    const identity = attachmentFileIdentity(file);
    if (!files.has(identity)) files.set(identity, file);
  }
  return { files, read, reveal, ...(sessionId === undefined ? {} : { sessionId }) };
}

/** Resolve one reserved-host URL to a directory file by exact contract match. */
function resolveAttachment(href: string, context: AttachmentContext): SessionFile | undefined {
  const ref = parseAttachmentRefUrl(href);
  if (ref === undefined) return undefined;
  return context.files.get(attachmentFileIdentity(ref));
}

/** The private hast property the transformer sets on a first reference. */
const ATTACHMENT_PREVIEW_PROP = 'dataWyAttachmentPreview';

/** The read slice of one hast node; only what this walk needs. */
interface HastLikeNode {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: unknown[];
}

/** Walk one hast subtree in document order, marking first references. */
function markFirstReferences(
  node: unknown,
  refs: ReadonlySet<string>,
  seen: Set<string>,
): void {
  if (typeof node !== 'object' || node === null) return;
  const element = node as HastLikeNode;
  // Only real anchors count: a reserved-host image never becomes the preview.
  if (element.type === 'element' && element.tagName === 'a') {
    const href = element.properties?.href;
    if (typeof href === 'string' && refs.has(href) && !seen.has(href)) {
      seen.add(href);
      element.properties = { ...element.properties, [ATTACHMENT_PREVIEW_PROP]: true };
    }
  }
  if (!Array.isArray(element.children)) return;
  for (const child of element.children) markFirstReferences(child, refs, seen);
}

/**
 * The transformer options: the exact attachment reference URLs plus the known
 * todo ids. Both are part of Streamdown's processor cache key, so one message's
 * directory or list never reuses another's processor.
 */
interface TodoLinkOptions {
  refs: readonly string[];
  ids: readonly string[];
}

/** Reserved href scheme that marks a known todo id in the parsed tree. */
const TODO_LINK_SCHEME = 'wrenyard-todo:';

/** Exact 8-hex token; a hex neighbour means the token is part of a longer word. */
const TODO_ID_PATTERN = /(?<![0-9a-f])[0-9a-f]{8}(?![0-9a-f])/g;

/**
 * Whether a matched token belongs to a path or a filename rather than prose:
 * a slash on either side, or a dot-plus-character suffix (`…/abc12345.md`).
 */
function isUrlFragment(text: string, start: number, end: number): boolean {
  const before = start > 0 ? text[start - 1] : undefined;
  if (before === '/' || before === '\\') return true;
  const after = end < text.length ? text[end] : undefined;
  if (after === '/') return true;
  if (after === '.') {
    const next = end + 1 < text.length ? text[end + 1] : undefined;
    if (next !== undefined && /[\p{L}\p{N}]/u.test(next)) return true;
  }
  return false;
}

/** One hast anchor carrying the reserved href that the `a` override resolves. */
function todoAnchor(todoId: string): HastLikeNode {
  return {
    type: 'element',
    tagName: 'a',
    properties: { href: `${TODO_LINK_SCHEME}${todoId}` },
    children: [{ type: 'text', value: todoId }],
  };
}

/** The text of a code element that holds exactly one text child. */
function exactCodeText(node: HastLikeNode): string | undefined {
  if (!Array.isArray(node.children) || node.children.length !== 1) return undefined;
  const child = node.children[0];
  if (typeof child !== 'object' || child === null) return undefined;
  const text = child as { type?: unknown; value?: unknown };
  return text.type === 'text' && typeof text.value === 'string' ? text.value : undefined;
}

/** Split one text node into text and todo-link pieces; undefined when unchanged. */
function splitTodoText(value: string, ids: ReadonlySet<string>): unknown[] | undefined {
  const pieces: unknown[] = [];
  let cursor = 0;
  for (const match of value.matchAll(TODO_ID_PATTERN)) {
    const token = match[0];
    const start = match.index;
    if (start === undefined || !ids.has(token)) continue;
    const end = start + token.length;
    if (isUrlFragment(value, start, end)) continue;
    if (start > cursor) pieces.push({ type: 'text', value: value.slice(cursor, start) });
    pieces.push(todoAnchor(token));
    cursor = end;
  }
  if (pieces.length === 0) return undefined;
  if (cursor < value.length) pieces.push({ type: 'text', value: value.slice(cursor) });
  return pieces;
}

/**
 * Link exact known todo ids in one element's children. Existing anchors and
 * fenced or indented code blocks are literal; inline code is handled as a unit
 * so its own styling survives and only a whole-id value becomes a link.
 */
function linkifyTodoChildren(children: unknown[], ids: ReadonlySet<string>): void {
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (typeof child !== 'object' || child === null) continue;
    const node = child as HastLikeNode;
    if (node.type === 'text') {
      const value = (node as { value?: unknown }).value;
      if (typeof value !== 'string') continue;
      const pieces = splitTodoText(value, ids);
      if (pieces === undefined) continue;
      children.splice(index, 1, ...pieces);
      index += pieces.length - 1;
      continue;
    }
    if (node.type !== 'element') continue;
    if (node.tagName === 'a' || node.tagName === 'pre') continue;
    if (node.tagName === 'code') {
      const text = exactCodeText(node);
      if (text !== undefined && ids.has(text)) node.children = [todoAnchor(text)];
      continue;
    }
    if (Array.isArray(node.children)) linkifyTodoChildren(node.children, ids);
  }
}

/**
 * A rehype transformer appended after Streamdown's default raw/sanitize/harden
 * plugins. It first annotates the first document-order anchor of each resolvable
 * attachment reference (later anchors of the same identity stay text-only), then
 * links exact known todo ids. The `seen` set is local to one traversal, so the
 * decision is a pure function of the parsed tree — no source offsets and no
 * mutable render-time state.
 */
function todoLinksPlugin(options?: TodoLinkOptions): (tree: unknown) => void {
  const refs = new Set(options?.refs ?? []);
  const ids = new Set(options?.ids ?? []);
  return (tree) => {
    markFirstReferences(tree, refs, new Set<string>());
    if (ids.size === 0) return;
    const root = tree as HastLikeNode;
    if (Array.isArray(root.children)) linkifyTodoChildren(root.children, ids);
  };
}

/** A degraded, inert notice for a reserved-host reference that cannot be resolved. */
function UnavailableAttachment({ label }: { label: ReactNode }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded border border-dashed px-1 text-xs text-muted-foreground"
      title="此附件引用不可用"
    >
      {label}
      <span className="text-[10px]">（附件不可用）</span>
    </span>
  );
}

/** A later reference to an already-previewed file: usable, but not a preview. */
function AttachmentTextLink({ file, label, onReveal }: {
  file: SessionFile;
  label: ReactNode;
  onReveal: RevealAttachment | undefined;
}) {
  if (onReveal === undefined) return <span>{label}</span>;
  return (
    <button
      type="button"
      className="inline cursor-pointer text-left underline underline-offset-2 hover:text-foreground"
      title={`在文件管理器中显示：${file.name}`}
      onClick={() => onReveal(file)}
    >
      {label}
    </button>
  );
}

/** The first reference to an image: an inline preview at the reference position. */
function InlineImageAttachment({ file, label, onRead, sessionId }: {
  file: SessionFile;
  label: ReactNode;
  onRead: ReadAttachment | undefined;
  sessionId: string | undefined;
}) {
  const [state, setState] = useState<{ src?: string; error?: string }>({});
  useEffect(() => {
    if (onRead === undefined) {
      setState({ error: '预览不可用' });
      return;
    }
    let cancelled = false;
    setState({});
    onRead(file).then((dataUrl) => {
      if (cancelled) return;
      setState(dataUrl === undefined || dataUrl === '' ? { error: '预览不可用' } : { src: dataUrl });
    }).catch(() => {
      if (!cancelled) setState({ error: '预览加载失败' });
    });
    return () => { cancelled = true; };
  }, [file, onRead]);

  const src = state.src;
  const register = useLightboxItem(src === undefined ? undefined : {
    name: file.name,
    src,
    ...(sessionId === undefined ? {} : { media: { sessionId, path: file.path } }),
  });
  return (
    <>
      <button
        ref={register}
        type="button"
        className="my-1 flex max-w-full cursor-zoom-in flex-col overflow-hidden rounded-xl border bg-muted text-left ring-1 ring-foreground/5 disabled:cursor-default"
        title={file.name}
        disabled={src === undefined}
        onClick={(event) => openLightbox(event.currentTarget)}
      >
        {src !== undefined ? (
          <img src={src} alt={file.name} className="max-h-72 w-auto max-w-full object-contain" />
        ) : (
          <span className="flex min-h-16 w-40 items-center justify-center p-2 text-center text-[10px] text-muted-foreground">
            {state.error ?? '加载中…'}
          </span>
        )}
        <span className="block border-t px-2 py-1 text-xs text-muted-foreground">{label}</span>
      </button>
    </>
  );
}

/** The first reference to an ordinary file: a link-style reveal control in place. */
function InlineFileAttachment({ file, label, onReveal }: {
  file: SessionFile;
  label: ReactNode;
  onReveal: RevealAttachment | undefined;
}) {
  if (onReveal === undefined) return <span>{label}</span>;
  return (
    <button
      type="button"
      className="mx-0.5 inline-flex max-w-full items-center gap-1 rounded-lg border bg-muted/60 px-2 py-0.5 align-middle text-xs ring-1 ring-foreground/5 hover:bg-muted"
      title={`在文件管理器中显示：${file.name}`}
      onClick={() => onReveal(file)}
    >
      <FileText className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{label}</span>
    </button>
  );
}

/** One parsed anchor whose href is on the reserved attachment host. */
function AttachmentReference({ href, label, node, context }: {
  href: string;
  label: ReactNode;
  node: ExtraProps['node'];
  context: AttachmentContext;
}) {
  const file = resolveAttachment(href, context);
  if (file === undefined) return <UnavailableAttachment label={label} />;
  const first = node?.properties?.[ATTACHMENT_PREVIEW_PROP] === true;
  if (!first) return <AttachmentTextLink file={file} label={label} onReveal={context.reveal} />;
  return file.kind === 'image'
    ? <InlineImageAttachment file={file} label={label} onRead={context.read} sessionId={context.sessionId} />
    : <InlineFileAttachment file={file} label={label} onReveal={context.reveal} />;
}

/**
 * Default image rendering for a non-reserved source. It forwards the hast node
 * so the surrounding paragraph still unwraps a standalone image, while keeping
 * the hast-only `node` prop off the DOM element.
 */
function PlainImage({ node: _node, ...rest }: ComponentProps<'img'> & ExtraProps) {
  return <img {...rest} />;
}

/**
 * Link safety stays in the pure renderer: the anchor never navigates in-app.
 * The embedder injects the external opener (the main-app shell bridge or the
 * narrow Pet appearance bridge), so this module loads without shell side
 * effects. Reserved-host references are read from the parsed anchor / image
 * nodes and never reach the external opener.
 */
function createComponents(onOpenExternal: OpenExternal | undefined): Components {
  return {
    a: (props) => {
      const context = useContext(AttachmentDirectory);
      const href = props.href;
      if (typeof href === 'string' && href.startsWith(TODO_LINK_SCHEME)) {
        return (
          <Suspense fallback={<span className="text-primary">{props.children}</span>}>
            <TodoLink todoId={href.slice(TODO_LINK_SCHEME.length)}>
              {props.children}
            </TodoLink>
          </Suspense>
        );
      }
      if (typeof href === 'string' && isAttachmentRefHost(href)) {
        return <AttachmentReference href={href} label={props.children} node={props.node} context={context} />;
      }
      return <MarkdownLink {...props} onOpenExternal={onOpenExternal} />;
    },
    img: (props) => {
      const src = props.src;
      if (typeof src === 'string' && isAttachmentRefHost(src)) {
        return <UnavailableAttachment label={typeof props.alt === 'string' ? props.alt : '图片'} />;
      }
      return <PlainImage {...props} />;
    },
  };
}

export interface MarkdownProps {
  children: string;
  streaming?: boolean;
  className?: string;
  /** Resolved dark appearance; the embedder supplies it instead of reading the theme store. */
  dark?: boolean;
  /** Opens http(s) links out of process; the anchor itself never navigates. */
  onOpenExternal?: OpenExternal;
  /** Task files the message may reference; only their exact reference URLs render in place. */
  attachments?: readonly SessionFile[];
  /** Reads one image attachment preview; the embedder binds the session media read. */
  onReadAttachment?: ReadAttachment;
  /** Reveals one attachment in the OS file manager; the embedder binds the session bridge. */
  onRevealAttachment?: RevealAttachment;
  /** Session owning the attachments, for the image lightbox. */
  attachmentSessionId?: string;
  /** Known todo ids; exact plain-text or inline-code occurrences become todo links. */
  todoIds?: ReadonlySet<string>;
}

/**
 * Streamdown configured for the conversation surface: code + CJK plugins, with
 * Mermaid fences routed to a lazily loaded diagram component. Other fenced code
 * is highlighted with the JavaScript Shiki engine.
 */
export function Markdown({
  children,
  streaming = false,
  className,
  dark = false,
  onOpenExternal,
  attachments,
  onReadAttachment,
  onRevealAttachment,
  attachmentSessionId,
  todoIds,
}: MarkdownProps) {
  // A message without attachments shares one stable empty context, so the
  // streaming path never re-renders settled blocks; a message with attachments
  // computes its directory once, deterministically, from the supplied files.
  const context = useMemo(
    () => (attachments === undefined || attachments.length === 0
      ? EMPTY_ATTACHMENT_CONTEXT
      : buildAttachmentDirectory(attachments, onReadAttachment, onRevealAttachment, attachmentSessionId)),
    [attachments, onReadAttachment, onRevealAttachment, attachmentSessionId],
  );
  // A message with an attachment directory parses the whole committed reply at
  // once. The transformer below walks the parsed tree and marks the first
  // reference of each identity, so it must see the whole message rather than
  // one streamed block at a time; it is appended after Streamdown's default
  // raw/sanitize/harden plugins, keeping that protection intact. Committed reply
  // text is static Markdown, so force static parsing here (no animation and no
  // caret, which are streaming-only affordances).
  const attachmentStatic = attachments !== undefined && attachments.length > 0;
  // Sorted once per set identity so the transformer options stay stable across
  // streaming re-renders; the plugin is rebuilt only when the list changes.
  const todoIdList = useMemo(
    () => (todoIds === undefined ? [] : [...todoIds].sort()),
    [todoIds],
  );
  const rehypePlugins = useMemo<RehypePlugins | undefined>(() => {
    if (context.files.size === 0 && todoIdList.length === 0) return undefined;
    const refs = [...context.files.values()].map(attachmentRefUrl);
    return [
      ...Object.values(defaultRehypePlugins),
      [todoLinksPlugin, { refs, ids: todoIdList }],
    ];
  }, [context, todoIdList]);
  const components = useMemo(() => createComponents(onOpenExternal), [onOpenExternal]);
  // Streamdown takes a [light, dark] pair; pin both slots to the active theme so
  // highlighting follows the resolved appearance instead of the CSS `dark:` class.
  const shikiTheme: [string, string] = dark
    ? [SHIKI_THEME.dark, SHIKI_THEME.dark]
    : [SHIKI_THEME.light, SHIKI_THEME.light];

  return (
    <MermaidDarkContext.Provider value={dark}>
      <AttachmentDirectory.Provider value={context}>
        <Streamdown
          mode={attachmentStatic ? 'static' : streaming ? 'streaming' : 'static'}
          isAnimating={attachmentStatic ? false : streaming}
          caret={attachmentStatic ? undefined : 'block'}
          plugins={PLUGINS}
          {...(rehypePlugins === undefined ? {} : { rehypePlugins })}
          shikiTheme={shikiTheme}
          components={components}
          className={cn(
            'text-sm',
            // Orphan control: prose paragraphs avoid a lone trailing word and
            // headings balance their lines. Overflow and break utilities are
            // descendant-scoped so inherited text-wrap never reaches code, pre
            // or table content.
            '[&_p]:text-pretty',
            '[&_h1]:text-balance [&_h2]:text-balance [&_h3]:text-balance',
            '[&_h4]:text-balance [&_h5]:text-balance [&_h6]:text-balance',
            // Fenced code blocks and wide tables scroll inside their own box
            // instead of widening the page; streamdown already preserves code
            // whitespace so no whitespace utility is needed on pre.
            '[&_pre]:overflow-x-auto',
            '[&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto',
            // Long inline code, links and unbreakable prose words wrap; inline
            // code breaking stays scoped to code not inside a pre block.
            '[&_:not(pre)>code]:break-all',
            '[&_a]:break-all',
            '[&_p]:break-words [&_li]:break-words',
            className,
          )}
        >
          {children}
        </Streamdown>
      </AttachmentDirectory.Provider>
    </MermaidDarkContext.Provider>
  );
}
