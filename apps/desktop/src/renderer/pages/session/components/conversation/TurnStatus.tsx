import { Square } from 'lucide-react';
import { Button } from '@/renderer/components/ui/button';
import { Message, MessageContent } from '@/renderer/components/ui/message';
import { Spinner } from '@/renderer/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { turnStatusText } from '../../model/describe.js';
import type { TurnModel } from '../../model/types.js';
import { useInspector } from '../inspector/Inspector.js';

export interface TurnStatusProps {
  turn: TurnModel;
  onInterrupt: (turn: number) => void;
}

/**
 * Live status line under a running turn: shimmering phase copy that jumps to
 * the turn, plus the interrupt control (disabled while the request is in
 * flight). Runs on the fold's own state, so it starts no timers.
 */
export function TurnStatus({ turn, onInterrupt }: TurnStatusProps) {
  const { inspect } = useInspector();
  return (
    <Message>
      <MessageContent>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            className="shimmer"
            onClick={() => inspect({ kind: 'turn', turnId: turn.id })}
          >
            {turnStatusText(turn)}
          </Button>
          {turn.interrupting ? (
            <Button variant="ghost" size="icon-sm" disabled aria-label="正在中断">
              <Spinner />
            </Button>
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={<Button variant="ghost" size="icon-sm" aria-label="中断此轮次" />}
                onClick={() => onInterrupt(turn.id)}
              >
                <Square />
              </TooltipTrigger>
              <TooltipContent>中断此轮次</TooltipContent>
            </Tooltip>
          )}
        </div>
      </MessageContent>
    </Message>
  );
}
