import { Check, CircleSlash, Gauge, SkipForward, X } from 'lucide-react';
import { Spinner } from '@/renderer/components/ui/spinner';
import { cn } from '@/renderer/lib/utils';

type Tone = 'running' | 'done' | 'failed' | 'muted' | 'lamp';

interface StatusSpec {
  label: string;
  tone: Tone;
}

const STATUS: Record<string, StatusSpec> = {
  running: { label: '运行中', tone: 'running' },
  done: { label: '完成', tone: 'done' },
  ok: { label: '成功', tone: 'done' },
  completed: { label: '已完成', tone: 'done' },
  failed: { label: '失败', tone: 'failed' },
  interrupted: { label: '已中断', tone: 'muted' },
  cancelled: { label: '已取消', tone: 'muted' },
  aborted: { label: '已取消', tone: 'muted' },
  skipped: { label: '已跳过', tone: 'muted' },
  exhausted: { label: '达到推理上限', tone: 'lamp' },
};

const TONE_CLASS: Record<Tone, string> = {
  running: 'text-primary',
  done: 'text-[var(--moss-deep)]',
  failed: 'text-destructive',
  muted: 'text-muted-foreground',
  lamp: 'text-[var(--lamp-deep)]',
};

function StatusIcon({ status, tone }: { status: string; tone: Tone }) {
  if (tone === 'running') return <Spinner className="size-3.5" />;
  if (status === 'skipped') return <SkipForward className="size-3.5" />;
  if (status === 'exhausted') return <Gauge className="size-3.5" />;
  if (tone === 'done') return <Check className="size-3.5" />;
  if (tone === 'failed') return <X className="size-3.5" />;
  return <CircleSlash className="size-3.5" />;
}

export interface StatusBadgeProps {
  status: string;
  label?: string;
  className?: string;
}

/** Unified status text, colour and icon for turns, actions and calls. */
export function StatusBadge({ status, label, className }: StatusBadgeProps) {
  const spec = STATUS[status] ?? { label: status, tone: 'muted' as Tone };
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs font-medium', TONE_CLASS[spec.tone], className)}>
      <StatusIcon status={status} tone={spec.tone} />
      {label ?? spec.label}
    </span>
  );
}
