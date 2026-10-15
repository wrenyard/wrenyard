import { useEffect, useState, type ReactNode } from 'react';
import DOMPurify from 'dompurify';
import { Maximize2, Minus, Plus, RotateCcw } from 'lucide-react';
import { CopySourceButton } from '@/renderer/components/copy-source-button';
import { Button } from '@/renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/renderer/components/ui/dialog';
import { cn } from 'cn';
import type { MermaidConfig } from 'mermaid';

/** Diagram source larger than this is not rendered; the source stays visible. */
const MAX_SOURCE_LENGTH = 20_000;
const DEFAULT_ZOOM = 1;
const ZOOM_STEP = 0.25;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;

export interface MermaidDiagramProps {
  code: string;
  dark: boolean;
}

type MermaidApi = typeof import('mermaid').default;

/**
 * Mermaid keeps a single global instance and config, so loading is memoized and
 * init+render are serialized. This keeps concurrent blocks and theme switches
 * from interleaving their config or their temporary DOM.
 */
let mermaidPromise: Promise<MermaidApi> | null = null;
let renderChain: Promise<unknown> = Promise.resolve();
let renderSeq = 0;

function loadMermaid(): Promise<MermaidApi> {
  mermaidPromise ??= import('mermaid').then((module) => module.default);
  return mermaidPromise;
}

function enqueueMermaid<T>(task: () => Promise<T>): Promise<T> {
  const run = renderChain.then(task, task);
  renderChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Security options are fixed here; untrusted source never reaches `initialize`.
 * The root-level `htmlLabels` takes precedence over diagram-specific settings
 * (flowchart included) in Mermaid 11.
 */
function buildConfig(dark: boolean): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    suppressErrorRendering: true,
    theme: dark ? 'dark' : 'default',
    fontFamily: 'inherit',
    maxTextSize: MAX_SOURCE_LENGTH,
    maxEdges: 500,
    flowchart: { useMaxWidth: true },
    sequence: { useMaxWidth: true },
  };
}

const CSS_COMMENT = /\/\*[\s\S]*?\*\//g;
/** A CSS backslash escape such as `\72` (an `r`), used to hide `url(` / tags. */
const CSS_ESCAPE = /\\(?:([0-9a-fA-F]{1,6})\s?|(.))/gs;

/** Resolves CSS escapes so escaped resource syntax becomes visible to the scan. */
function decodeCssEscapes(value: string): string {
  return value.replace(CSS_ESCAPE, (_match, hex: string | undefined, literal: string | undefined) => {
    if (hex !== undefined) {
      const code = Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return literal ?? '';
  });
}

/** Drops CSS comments and escapes so obfuscated resource syntax is scannable. */
function normalizeForScan(value: string): string {
  return decodeCssEscapes(value.replace(CSS_COMMENT, ''));
}

/**
 * Resource-loading or link-emitting syntax is rejected before Mermaid renders,
 * because Mermaid builds temporary DOM (and can fetch images or install a
 * user-controlled stylesheet) before any output sanitization could run. The
 * installed Mermaid merges frontmatter/`%%{init}%%` config over our own, so both
 * are rejected rather than merged. `<br/>` and plain labels stay allowed.
 *
 * Statements may be separated by `;` as well as newlines, and CSS escapes or
 * entity encoding can hide the same tokens, so each pattern is tested against
 * the raw source and against a comment-stripped, escape-decoded copy.
 */
const UNSAFE_SOURCE: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /%%\s*\{/, reason: '图表包含初始化指令' },
  { pattern: /^[\uFEFF\s]*---/, reason: '图表包含 frontmatter 配置' },
  // Expanded `@{ ... }` metadata can carry resource-bearing keys (e.g. images),
  // and quoted keys such as `@{ "img": "file:///..." }` slip past the bare name scan.
  { pattern: /@\s*\{/, reason: '图表包含受限的节点元数据' },
  { pattern: /(?:^|[;\n\r])\s*(?:classDef|style|linkStyle)\b/i, reason: '图表包含自定义样式指令' },
  { pattern: /\burl\s*\(/i, reason: '图表包含外部资源地址' },
  { pattern: /@import/i, reason: '图表包含外部样式引用' },
  { pattern: /!\[[^\]]*\]\s*\(/, reason: '图表包含 Markdown 图片' },
  // Any raw HTML-like tag is rejected unless it is a bare `<br>` variant with no
  // attributes; enumerating resource tags would miss style/link/source-like paths.
  { pattern: /<(?!br\s*\/?\s*>)\/?[A-Za-z!?][^>]*>/i, reason: '图表包含受限的 HTML 标签' },
  // Mermaid decodes HTML entities, so an encoded `<` must never reach the parser.
  { pattern: /(?:&lt;|&#0*60;|&#[xX]0*3c;)/i, reason: '图表包含转义的 HTML 标签' },
  { pattern: /\b(?:img|image|icon)\s*[:=]/i, reason: '图表包含外部资源引用' },
  { pattern: /\b(?:xlink:href|href)\s*[:=]/i, reason: '图表包含外部链接' },
  { pattern: /\bjavascript:/i, reason: '图表包含脚本协议' },
  { pattern: /(?:^|[;\n\r])\s*click\b/i, reason: '图表包含跳转指令' },
];

type MermaidRenderState =
  | { status: 'loading' }
  | { status: 'ready'; svg: string }
  | { status: 'error'; message: string };

function sourceIssue(source: string): string | null {
  if (source.length > MAX_SOURCE_LENGTH) return '图表源码过长，未渲染';
  const normalized = normalizeForScan(source);
  for (const { pattern, reason } of UNSAFE_SOURCE) {
    if (pattern.test(source) || pattern.test(normalized)) return reason;
  }
  return null;
}

/** Resource-capable SVG elements removed from the rendered output. */
const FORBIDDEN_SVG_TAGS = [
  'script',
  'foreignobject',
  'image',
  'feimage',
  'iframe',
  'object',
  'embed',
  'audio',
  'video',
  'animate',
  'animatemotion',
  'animatetransform',
  'set',
  'discard',
];
const FORBIDDEN_OUTPUT_TAGS = new Set(FORBIDDEN_SVG_TAGS);

/** Only a bare local fragment such as `#diagram-1` may survive as a URL. */
const FRAGMENT_URL = /^['"]?#[A-Za-z_][\w:.-]*['"]?$/;
const FRAGMENT_HREF = /^#[A-Za-z_][\w:.-]*$/;
/** Attribute values that need CSS (or escape) inspection. */
const CSS_BEARING = /url\(|@import|\\/i;

/**
 * Neutralizes CSS resource references: comments and escapes are resolved first,
 * then every `url(...)` that is not exactly a local fragment is dropped, so a
 * value is never kept merely because it contains a `#`.
 */
function sanitizeCssValue(value: string): string {
  return decodeCssEscapes(value.replace(CSS_COMMENT, ''))
    .replace(/@import[^;]*;?/gi, '')
    .replace(/expression\s*\(/gi, 'none(')
    .replace(/url\(\s*([^)]*?)\s*\)/gi, (match, body: string) =>
      FRAGMENT_URL.test(body.trim()) ? match : 'none');
}

/** Strips event handlers, external links and CSS URLs from one element. */
function sanitizeSvgElement(element: Element): void {
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();
    if (name.startsWith('on')) {
      element.removeAttribute(attribute.name);
      continue;
    }
    if (name === 'href' || name === 'xlink:href') {
      if (!FRAGMENT_HREF.test(attribute.value.trim())) element.removeAttribute(attribute.name);
      continue;
    }
    if (name === 'style' || CSS_BEARING.test(attribute.value)) {
      const cleaned = sanitizeCssValue(attribute.value);
      if (cleaned !== attribute.value) element.setAttribute(attribute.name, cleaned);
    }
  }
  if (element.localName.toLowerCase() === 'style') {
    element.textContent = sanitizeCssValue(element.textContent ?? '');
  }
}

/** Replaces Mermaid's `width="100%"` sizing with the intrinsic viewBox size. */
function applyNaturalSize(root: Element): void {
  const viewBox = root.getAttribute('viewBox') ?? root.getAttribute('viewbox');
  if (viewBox === null) return;
  const parts = viewBox.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) return;
  const [, , width, height] = parts;
  if (!(width > 0) || !(height > 0)) return;
  root.setAttribute('width', String(width));
  root.setAttribute('height', String(height));
  root.removeAttribute('style');
}

/**
 * Defense in depth over Mermaid's own sanitizer. It inspects the SVG root as
 * well as every descendant, drops resource-capable elements, keeps only exact
 * fragment links and `url(#id)` references, and rewrites the root to its
 * intrinsic size. It returns `null` when the SVG cannot be fully inspected, so
 * a parse failure fails closed instead of handing back a partially sanitized
 * string.
 */
function sanitizeSvg(raw: string): string | null {
  const purified = DOMPurify.sanitize(raw, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: [...FORBIDDEN_SVG_TAGS],
  });
  if (typeof DOMParser === 'undefined' || typeof XMLSerializer === 'undefined') return null;

  const doc = new DOMParser().parseFromString(purified, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() === 'parsererror') return null;

  for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
    if (FORBIDDEN_OUTPUT_TAGS.has(element.localName.toLowerCase())) {
      element.remove();
      continue;
    }
    sanitizeSvgElement(element);
  }
  applyNaturalSize(root);
  return new XMLSerializer().serializeToString(root);
}

function ViewToggle({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'rounded-md px-2 py-0.5 text-xs transition-colors',
        active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

/**
 * Renders one completed Mermaid fence. The library is imported lazily by the
 * caller, so this module (and Mermaid with it) only loads when a diagram appears.
 */
export function MermaidDiagram({ code, dark }: MermaidDiagramProps) {
  const [mode, setMode] = useState<'diagram' | 'source'>('diagram');
  const [state, setState] = useState<MermaidRenderState>({ status: 'loading' });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);

  useEffect(() => {
    let active = true;
    const issue = sourceIssue(code);
    if (issue) {
      setState({ status: 'error', message: issue });
      return () => {
        active = false;
      };
    }

    setState({ status: 'loading' });
    const id = `mermaid-${(renderSeq += 1)}`;
    const job = enqueueMermaid(async (): Promise<string | null> => {
      if (!active) return null;
      const mermaid = await loadMermaid();
      if (!active) return null;
      mermaid.initialize(buildConfig(dark));
      const { svg } = await mermaid.render(id, code);
      return sanitizeSvg(svg);
    });
    job.then(
      (svg) => {
        if (!active) return;
        if (svg === null) {
          // Sanitization could not fully inspect the SVG; fail closed.
          setState({ status: 'error', message: '图表无法安全渲染' });
          return;
        }
        setState({ status: 'ready', svg });
      },
      () => {
        if (!active) return;
        setState({ status: 'error', message: '图表无法渲染' });
      },
    );

    return () => {
      // Discard stale results; Mermaid removes its own temporary DOM.
      active = false;
    };
  }, [code, dark]);

  const svg = state.status === 'ready' ? state.svg : null;

  const openDialog = (): void => {
    setZoom(DEFAULT_ZOOM);
    setDialogOpen(true);
  };

  return (
    <div className="my-4 overflow-hidden rounded-xl border border-border bg-sidebar" data-streamdown="mermaid">
      <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
        <div className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
          <ViewToggle active={mode === 'diagram'} onClick={() => setMode('diagram')}>
            图表
          </ViewToggle>
          <ViewToggle active={mode === 'source'} onClick={() => setMode('source')}>
            源码
          </ViewToggle>
        </div>
        <div className="ml-auto flex items-center gap-0.5">
          <CopySourceButton code={code} />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="查看大图"
            title="查看大图"
            disabled={!svg}
            onClick={openDialog}
          >
            <Maximize2 />
          </Button>
        </div>
      </div>

      {mode === 'source' ? (
        <pre className="max-h-96 overflow-auto p-3 text-xs">{code}</pre>
      ) : (
        <div className="overflow-auto p-3">
          {svg ? (
            dialogOpen ? (
              // While the dialog owns the only mounted copy of the SVG, the
              // inline chart is replaced by a placeholder so its IDs and marker
              // references are never duplicated in the document.
              <p className="text-xs text-muted-foreground">已在大图预览中查看此图表。</p>
            ) : (
              <div
                className="[&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            )
          ) : state.status === 'error' ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                {state.message}。出于安全限制，受限的节点元数据或 HTML 标签不会被渲染，以下为原始源码：
              </p>
              <pre className="max-h-80 overflow-auto rounded-lg bg-muted/40 p-2 text-xs">{code}</pre>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">正在渲染图表…</p>
          )}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="w-[min(96vw,1100px)] sm:max-w-[min(96vw,1100px)]">
          <DialogHeader>
            <DialogTitle>图表预览</DialogTitle>
            <DialogDescription>可放大、缩小或重置缩放，以便查看较大或较长的图表。</DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label="缩小"
              title="缩小"
              disabled={zoom <= MIN_ZOOM}
              onClick={() => setZoom((value) => Math.max(MIN_ZOOM, Number((value - ZOOM_STEP).toFixed(2))))}
            >
              <Minus />
            </Button>
            <span className="w-12 text-center text-xs tabular-nums text-muted-foreground">
              {Math.round(zoom * 100)}%
            </span>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label="放大"
              title="放大"
              disabled={zoom >= MAX_ZOOM}
              onClick={() => setZoom((value) => Math.min(MAX_ZOOM, Number((value + ZOOM_STEP).toFixed(2))))}
            >
              <Plus />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label="重置缩放"
              title="重置缩放"
              disabled={zoom === DEFAULT_ZOOM}
              onClick={() => setZoom(DEFAULT_ZOOM)}
            >
              <RotateCcw />
            </Button>
          </div>
          <div className="max-h-[70vh] overflow-auto rounded-lg border border-border bg-background p-4">
            {svg && dialogOpen ? (
              // Mounted only while the dialog is open, so the document never
              // holds two copies of the same SVG (and its element IDs) at once.
              <div
                className="[&_svg]:max-w-none"
                style={{ zoom }}
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
