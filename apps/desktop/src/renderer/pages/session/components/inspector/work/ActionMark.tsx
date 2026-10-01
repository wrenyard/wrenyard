import { Zap } from 'lucide-react';
import { Button } from '@/renderer/components/ui/button';
import type { BlockModel } from '../../../model/types.js';
import { useInspector } from '../Inspector.js';

export interface ActionMarkProps {
  block: BlockModel;
  turnId: number;
  actionCount: number;
}

/** Compact jump link from a reasoning block to its parsed actions. */
export function ActionMark({ block, turnId, actionCount }: ActionMarkProps) {
  const { inspect } = useInspector();
  const firstLine = block.text.split('\n', 1)[0] ?? '';
  return (
    <Button
      variant="ghost"
      className="w-full justify-start"
      onClick={() => inspect({ kind: 'block', turnId, blockId: block.blockId })}
    >
      <Zap className="text-chart-2" />
      <span className="truncate">{firstLine}</span>
      <span className="text-muted-foreground">→ {actionCount} 个行动</span>
    </Button>
  );
}
