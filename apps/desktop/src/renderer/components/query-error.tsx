import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';

/**
 * The subset of a TanStack query the error surface needs. Kept structural so
 * any `useQuery` result (or shell-read equivalent) satisfies it.
 */
export interface QueryErrorQuery {
  error: unknown;
  isFetching: boolean;
  refetch: () => Promise<unknown>;
}

export interface QueryErrorProps {
  query: QueryErrorQuery;
  /** Optional heading; omitted when the caller already supplies its own copy. */
  title?: string;
  /** Optional replacement description; defaults to the query error message. */
  description?: string;
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message;
  if (typeof error === 'string' && error !== '') return error;
  if (error === undefined || error === null) return '未知错误';
  return String(error);
}

/**
 * Shared query failure surface: a destructive alert with the actual error and
 * a retry action. Visibility is the parent's call — unavailable snapshots may
 * still need a retry even when the query is not formally in error.
 */
export function QueryError({ query, title, description }: QueryErrorProps) {
  return (
    <Alert variant="destructive">
      {title !== undefined && <AlertTitle>{title}</AlertTitle>}
      <AlertDescription>{description ?? errorText(query.error)}</AlertDescription>
      <AlertAction>
        <Button
          variant="outline"
          disabled={query.isFetching}
          onClick={() => { void query.refetch(); }}
        >
          重试
        </Button>
      </AlertAction>
    </Alert>
  );
}
