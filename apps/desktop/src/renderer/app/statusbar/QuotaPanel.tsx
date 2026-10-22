import { ArrowUpRight } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { UsageCardSkeletonBody } from '@/renderer/components/usage/UsageCard';
import { QuotaProviderBlock } from '@/renderer/components/usage/QuotaProviderBlock';
import { quotaQuery } from '@/renderer/lib/queries';
import { executeCommand } from '@/renderer/lib/commands';

const QUOTA_READ_FAILED = '额度读取失败';
const RETRY_LABEL = '重试';
const NO_PROVIDER_QUOTA = '当前模型没有额度数据';

export interface QuotaPanelProps {
  /** Provider id to show; empty or missing from the snapshot renders a muted note. */
  providerId?: string;
}

export function QuotaPanel({ providerId }: QuotaPanelProps = {}) {
  const { data, isPending, isError, refetch, isFetching } = useQuery(quotaQuery);
  const provider = providerId !== undefined && providerId !== ''
    ? data?.providers.find((entry) => entry.id === providerId)
    : undefined;

  if (isPending && data === undefined) {
    return (
      <div className="flex w-full min-w-0 flex-col gap-2.5">
        <UsageCardSkeletonBody />
      </div>
    );
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-2.5">
      {isError && data === undefined ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{QUOTA_READ_FAILED}</span>
          <Button
            type="button"
            variant="link"
            size="xs"
            disabled={isFetching}
            onClick={() => void refetch()}
          >
            {RETRY_LABEL}
          </Button>
        </div>
      ) : provider === undefined ? (
        <p className="text-xs text-muted-foreground">{NO_PROVIDER_QUOTA}</p>
      ) : (
        <QuotaProviderBlock provider={provider} />
      )}
    </div>
  );
}

export function QuotaCardActions() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={(
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="查看全部额度"
            onClick={() => executeCommand('settings.open', 'usage')}
          />
        )}
      >
        <ArrowUpRight />
      </TooltipTrigger>
      <TooltipContent>查看全部额度</TooltipContent>
    </Tooltip>
  );
}
