import type { ReactNode } from 'react';
import type {
  ActionModel,
  BlockModel,
  ContextItem,
  CycleModel,
  TurnModel,
} from '../../model/types.js';

/** One label/value row of a detail pane. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] items-start gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

/** A titled detail section. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  );
}

/** Muted placeholder shown when an inspected target cannot be resolved. */
export function EmptyNote({ text }: { text: string }) {
  return <p className="text-sm text-muted-foreground">{text}</p>;
}

/** Small inline selection control that jumps to another inspector target. */
export function InspectLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="text-left text-sm hover:underline" onClick={onClick}>
      {children}
    </button>
  );
}

export function findTurn(model: { turns: TurnModel[] }, id: number): TurnModel | undefined {
  return model.turns.find((turn) => turn.id === id);
}

export function findCycle(turn: TurnModel, index: number): CycleModel | undefined {
  return turn.cycles.find((cycle) => cycle.index === index);
}

export function findAction(turn: TurnModel, actionId: string): ActionModel | undefined {
  return turn.actions.find((action) => action.id === actionId);
}

export function findBlock(turn: TurnModel, blockId: string): { block: BlockModel; cycle: CycleModel } | undefined {
  for (const cycle of turn.cycles) {
    const block = cycle.blocks.find((candidate) => candidate.blockId === blockId);
    if (block) return { block, cycle };
  }
  return undefined;
}

export function findContext(turn: TurnModel, key: string): { item: ContextItem; cycle?: CycleModel; action?: ActionModel } | undefined {
  for (const cycle of turn.cycles) {
    const item = cycle.context.find((candidate) => candidate.key === key);
    if (item) return { item, cycle };
  }
  for (const action of turn.actions) {
    const item = action.outputs.find((candidate) => candidate.key === key);
    if (item) return { item, action };
  }
  return undefined;
}
