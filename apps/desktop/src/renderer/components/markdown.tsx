import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/renderer/components/ui/dialog';
import { ImageViewer } from '@/renderer/components/image-viewer';
import {
  MermaidBlock,
  MermaidDarkContext,
} from '@/renderer/components/mermaid-renderer';

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
): AttachmentContext {
  const files = new Map<string, SessionFile>();
  for (const file of attachments) {
    // Only Task outputs are citable here; user uploads keep their own components.
    if (file.source !== 'task') continue;
    const identity = attachmentFileIdentity(file);
    if (!files.has(identity)) files.set(identity, file);
  }
  return { files, read, reveal };
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

/**
 * The transformer options: the exact reference URLs of every resolvable
 * directory identity. They are also part of Streamdown's processor cache key,
 * so one message's directory never reuses another message's processor.
 */
interface AttachmentPreviewOptions {
  refs: readonly string[];
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
 * A rehype transformer appended after Streamdown's default raw/sanitize/harden
 * plugins: it annotates the first document-order anchor of each resolvable
 * reference, and every later anchor of the same identity stays text-only. The
 * `seen` set is local to one traversal, so the decision is a pure function of
 * the parsed tree — no source offsets and no mutable render-time state.
 */
function attachmentPreviewPlugin(options?: AttachmentPreviewOptions): (tree: unknown) => void {
  const refs = new Set(options?.refs ?? []);
  return (tree) => {
    markFirstReferences(tree, refs, new Set<string>());
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
function InlineImageAttachment({ file, label, onRead }: {
  file: SessionFile;
  label: ReactNode;
  onRead: ReadAttachment | undefined;
}) {
  const [state, setState] = useState<{ src?: string; error?: string }>({});
  const [open, setOpen] = useState(false);
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
  return (
    <>
      <button
        type="button"
        className="my-1 flex max-w-full flex-col overflow-hidden rounded-xl border bg-muted text-left ring-1 ring-foreground/5 disabled:cursor-default"
        title={file.name}
        disabled={src === undefined}
        onClick={() => { if (src !== undefined) setOpen(true); }}
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
      {open && src !== undefined && createPortal(
        <Dialog open onOpenChange={(next) => { if (!next) setOpen(false); }}>
          <DialogContent className="max-w-[min(90vw,64rem)]">
            <DialogTitle className="truncate">{file.name}</DialogTitle>
            <DialogDescription className="sr-only">附件图片预览</DialogDescription>
            <ImageViewer src={src} alt={file.name} />
          </DialogContent>
        </Dialog>,
        document.body,
      )}
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
    ? <InlineImageAttachment file={file} label={label} onRead={context.read} />
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
}: MarkdownProps) {
  // A message without attachments shares one stable empty context, so the
  // streaming path never re-renders settled blocks; a message with attachments
  // computes its directory once, deterministically, from the supplied files.
  const context = useMemo(
    () => (attachments === undefined || attachments.length === 0
      ? EMPTY_ATTACHMENT_CONTEXT
      : buildAttachmentDirectory(attachments, onReadAttachment, onRevealAttachment)),
    [attachments, onReadAttachment, onRevealAttachment],
  );
  // A message with an attachment directory parses the whole committed reply at
  // once. The transformer below walks the parsed tree and marks the first
  // reference of each identity, so it must see the whole message rather than
  // one streamed block at a time; it is appended after Streamdown's default
  // raw/sanitize/harden plugins, keeping that protection intact. Committed reply
  // text is static Markdown, so force static parsing here (no animation and no
  // caret, which are streaming-only affordances).
  const attachmentStatic = attachments !== undefined && attachments.length > 0;
  const rehypePlugins = useMemo<RehypePlugins | undefined>(() => {
    if (context.files.size === 0) return undefined;
    const refs = [...context.files.values()].map(attachmentRefUrl);
    return [...Object.values(defaultRehypePlugins), [attachmentPreviewPlugin, { refs }]];
  }, [context]);
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
            // headings balance their lines. The utilities target the elements
            // themselves (p/h1-h6), so inherited text-wrap never reaches code,
            // pre or table content.
            '[&_p]:text-pretty',
            '[&_h1]:text-balance [&_h2]:text-balance [&_h3]:text-balance',
            '[&_h4]:text-balance [&_h5]:text-balance [&_h6]:text-balance',
            className,
          )}
        >
          {children}
        </Streamdown>
      </AttachmentDirectory.Provider>
    </MermaidDarkContext.Provider>
  );
}
