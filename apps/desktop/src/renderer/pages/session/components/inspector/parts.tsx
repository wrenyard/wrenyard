import { Children, Fragment, type ReactNode } from 'react';
import { Button } from '@/renderer/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/renderer/components/ui/card';
import { Item, ItemContent, ItemDescription } from '@/renderer/components/ui/item';
import { Separator } from '@/renderer/components/ui/separator';
import type {
  ActionModel,
  ContextItem,
  CycleModel,
  TurnModel,
} from '../../model/types.js';

/** One label/value row of a detail pane. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] items-start gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 font-medium tabular-nums">{children}</span>
    </div>
  );
}

/** A grouped list of contiguous {@link Field} rows separated by dividers. */
export function Fields({ children }: { children: ReactNode }) {
  const rows = Children.toArray(children).filter(Boolean);
  return (
    <Item variant="muted">
      <ItemContent className="flex-col gap-3">
        {rows.map((row, index) => (
          <Fragment key={index}>
            {index > 0 ? <Separator /> : null}
            {row}
          </Fragment>
        ))}
      </ItemContent>
    </Item>
  );
}

/** A titled detail section. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/** Muted placeholder shown when an inspected target cannot be resolved. */
export function EmptyNote({ text }: { text: string }) {
  return <ItemDescription>{text}</ItemDescription>;
}

/** Small inline selection control that jumps to another inspector target. */
export function InspectLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <Button variant="ghost" onClick={onClick}>
      {children}
    </Button>
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
