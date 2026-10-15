import { createContext, useContext, useEffect, useState, type ComponentType } from 'react';
import { CopySourceButton } from '@/renderer/components/copy-source-button';
import type { CustomRendererProps } from 'streamdown';
import type { MermaidDiagramProps } from '@/renderer/components/mermaid-diagram';

/**
 * Resolved dark appearance, kept as a boolean so its identity is stable. The
 * diagram component reads it from context and is never remounted merely because
 * the surrounding message re-renders while streaming.
 */
export const MermaidDarkContext = createContext(false);

type DiagramComponent = ComponentType<MermaidDiagramProps>;

/** Quiet waiting source view used while streaming or before the library loads. */
function MermaidPending({ code, status }: { code: string; status: string }) {
  return (
    <div className="my-4 overflow-hidden rounded-xl border border-border bg-sidebar" data-streamdown="mermaid-pending">
      <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
        <span className="text-xs text-muted-foreground">{status}</span>
        <div className="ml-auto">
          <CopySourceButton code={code} />
        </div>
      </div>
      <pre className="max-h-96 overflow-auto p-3 text-xs">{code}</pre>
    </div>
  );
}

/**
 * Streamdown custom fence renderer for `mermaid`. Streamdown wraps it in its own
 * Suspense boundary and looks it up before Shiki, so non-Mermaid fences keep
 * their syntax highlighting untouched.
 *
 * An incomplete fence is never rendered: a quiet waiting view with the source is
 * shown instead, which also avoids transient syntax errors mid-stream. The heavy
 * diagram module is imported only after the fence completes, and an import
 * failure is handled here rather than surfacing as an unhandled rejection.
 */
export function MermaidBlock({ code, isIncomplete }: CustomRendererProps) {
  const dark = useContext(MermaidDarkContext);
  const [Diagram, setDiagram] = useState<DiagramComponent | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    if (isIncomplete) return;
    let active = true;
    void import('@/renderer/components/mermaid-diagram').then(
      (module) => {
        if (active) setDiagram(() => module.MermaidDiagram);
      },
      () => {
        if (active) setLoadFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [isIncomplete]);

  if (isIncomplete) return <MermaidPending code={code} status="图表生成中…" />;
  if (loadFailed) return <MermaidPending code={code} status="图表组件加载失败，已保留源码。" />;
  if (!Diagram) return <MermaidPending code={code} status="正在加载图表渲染…" />;

  return <Diagram code={code} dark={dark} />;
}
