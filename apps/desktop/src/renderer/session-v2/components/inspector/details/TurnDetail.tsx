import { Separator } from '@/renderer/components/ui/separator';
import { StatusBadge } from '@/renderer/components/status-badge';
import { statusView } from '../../../model/describe.js';
import type { TurnModel } from '../../../model/types.js';
import { TurnMeta } from '../../conversation/TurnMeta.js';
import { Field } from '../parts.js';

/** Turn header: model, reasoning effort, status and the full statistics block. */
export function TurnDetail({ turn }: { turn: TurnModel }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Field label="模型">{`${turn.model.provider}/${turn.model.model}`}</Field>
        {turn.model.reasoningEffort && <Field label="推理强度">{turn.model.reasoningEffort}</Field>}
        <Field label="状态"><StatusBadge {...statusView(turn.status)} /></Field>
      </div>
      <Separator />
      <TurnMeta turn={turn} />
    </div>
  );
}
