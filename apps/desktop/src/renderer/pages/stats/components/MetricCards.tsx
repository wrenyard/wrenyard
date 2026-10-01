import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from '@/renderer/components/ui/card';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import type { MetricCard } from '../model/stats.js';

/** Four headline metrics; loading shows skeletons in place of value and footnote. */
export function MetricCards({ cards, loading = false }: { cards: MetricCard[]; loading?: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-4 @xl/main:grid-cols-2 @5xl/main:grid-cols-4">
      {cards.map((card) => (
        <Card key={card.label}>
          <CardHeader>
            <CardDescription>{card.label}</CardDescription>
            {loading
              ? <Skeleton className="h-7 w-24" />
              : <CardTitle className="text-2xl font-semibold tabular-nums">{card.value}</CardTitle>}
          </CardHeader>
          <CardFooter className="text-muted-foreground">
            {loading ? <Skeleton className="h-4 w-32" /> : card.note}
          </CardFooter>
        </Card>
      ))}
    </div>
  );
}
