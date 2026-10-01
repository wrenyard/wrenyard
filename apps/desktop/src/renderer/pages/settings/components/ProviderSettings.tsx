import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { QueryError } from '@/renderer/components/query-error';
import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/renderer/components/ui/item';
import { Label } from '@/renderer/components/ui/label';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import { useConfirm } from '@/renderer/hooks/use-confirm';
import { shell } from '@/renderer/lib/desktop';
import { navigate } from '@/renderer/lib/navigation';
import { taskSettingsQuery } from '@/renderer/lib/queries';
import {
  ALIAS_DELETE_LABEL,
  ALIAS_EMPTY,
  ALIAS_ERRORS,
  ALIAS_NAME_LABEL,
  ALIAS_NAME_PLACEHOLDER,
  ALIAS_NAME_RULE,
  ALIAS_REFRESH_LABEL,
  ALIAS_SUBMIT_LABEL,
  ALIAS_TARGET_LABEL,
  ALIAS_TARGET_PLACEHOLDER,
  AUTO_CAP_FIELD_LABEL,
  AUTO_CAP_LOADING,
  AUTO_CAP_PLACEHOLDER,
  AUTO_CAP_UNIT,
  AUTO_CAP_UNAVAILABLE,
  CONFLICT_MESSAGE,
  PROVIDER_COUNT_SUFFIX,
  PROVIDER_MANAGE_LABEL,
  autoCapEffectiveText,
  autoCapErrorMessage,
} from '../model/describe.js';
import { autoCapDisplayValue, errorMessage, parseAutoCapInput, validateAlias } from '../model/settings.js';
import { runtimeAliasesQueryKey, useQuotaQuery, useRuntimeAliasesQuery } from '../queries.js';

/** Read-only provider count with a link to the model-supply page. */
export function ProviderSummaryControl() {
  const quota = useQuotaQuery();
  if (quota.isPending) return <Skeleton className="h-5 w-24" />;
  if (quota.isError) return <QueryError query={quota} title="读取失败" />;
  const count = quota.data.catalog.filter((provider) => provider.configured).length;
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-muted-foreground">{`${count}${PROVIDER_COUNT_SUFFIX}`}</span>
      <Button variant="outline" onClick={() => { void navigate('quota'); }}>
        <ExternalLink />
        {PROVIDER_MANAGE_LABEL}
      </Button>
    </div>
  );
}

/**
 * The global auto-dispatch reference output cap. Committing on blur writes only
 * the `max_auto_output_usd_per_million` field at global scope; empty clears it.
 */
export function AutoPriceCapControl() {
  const queryClient = useQueryClient();
  const settings = useQuery(taskSettingsQuery());
  const revision = settings.data?.revision ?? '';
  const capValue = settings.data?.user_global.max_auto_output_usd_per_million;

  const [input, setInput] = useState('');
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState('');
  const [isError, setIsError] = useState(false);

  useEffect(() => {
    if (settings.data && !dirty) setInput(autoCapDisplayValue(capValue));
  }, [settings.data, dirty, capValue]);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['taskSettings'] });
  };

  const save = useMutation({
    mutationFn: (value: number | null) => shell.saveTaskSettings({
      scope: 'global',
      expected_revision: revision,
      patch: { max_auto_output_usd_per_million: value },
    }),
    onSuccess: () => {
      setDirty(false);
      setStatus('已保存');
      setIsError(false);
      invalidate();
    },
    onError: (error) => {
      const message = errorMessage(error);
      setStatus(message.includes('冲突') ? CONFLICT_MESSAGE : `保存失败：${message}`);
      setIsError(true);
      invalidate();
    },
  });

  const commit = (): void => {
    const parsed = parseAutoCapInput(input);
    if (!parsed.ok) {
      setStatus(autoCapErrorMessage(parsed));
      setIsError(true);
      return;
    }
    setIsError(false);
    setStatus('');
    save.mutate(parsed.value);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Input
          type="number"
          min={0}
          step={0.5}
          className="w-30"
          placeholder={AUTO_CAP_PLACEHOLDER}
          aria-label={AUTO_CAP_FIELD_LABEL}
          aria-invalid={isError}
          value={input}
          disabled={settings.isPending || save.isPending}
          onChange={(event) => {
            setDirty(true);
            setStatus('');
            setIsError(false);
            setInput(event.target.value);
          }}
          onBlur={commit}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit(); } }}
        />
        <span className="whitespace-nowrap text-sm text-muted-foreground">{AUTO_CAP_UNIT}</span>
      </div>
      <p className="text-sm text-muted-foreground">
        {settings.isPending
          ? AUTO_CAP_LOADING
          : settings.isError
            ? AUTO_CAP_UNAVAILABLE
            : autoCapEffectiveText(capValue)}
      </p>
      {status !== '' && (
        <p className={isError ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'} role="status">
          {status}
        </p>
      )}
    </div>
  );
}

/**
 * The daemon-owned runtime alias store: add an alias, list existing aliases and
 * delete with confirmation. Writes go only through the typed alias APIs.
 */
export function RuntimeAliasesControl() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const aliases = useRuntimeAliasesQuery();

  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [aliasError, setAliasError] = useState('');

  const put = useMutation({
    mutationFn: (entry: { name: string; target: string }) => shell.runtimeAliasPut({
      expected_revision: aliases.data?.revision ?? '',
      name: entry.name,
      target: entry.target,
    }),
    onSuccess: (snapshot) => {
      queryClient.setQueryData(runtimeAliasesQueryKey, snapshot);
      setName('');
      setTarget('');
      setAliasError('');
    },
    onError: (error) => {
      const message = errorMessage(error);
      setAliasError(message.includes('冲突') ? '保存冲突：别名列表已刷新，请重新提交。' : `保存失败：${message}`);
      if (message.includes('冲突')) void queryClient.invalidateQueries({ queryKey: runtimeAliasesQueryKey });
    },
  });

  const remove = useMutation({
    mutationFn: (aliasName: string) => shell.runtimeAliasRemove({
      expected_revision: aliases.data?.revision ?? '',
      name: aliasName,
    }),
    onSuccess: (snapshot) => queryClient.setQueryData(runtimeAliasesQueryKey, snapshot),
    onError: (error) => {
      const message = errorMessage(error);
      setAliasError(message.includes('冲突') ? '删除冲突：别名列表已刷新，请重试。' : `删除失败：${message}`);
      if (message.includes('冲突')) void queryClient.invalidateQueries({ queryKey: runtimeAliasesQueryKey });
    },
  });

  const onSubmit = (): void => {
    const trimmedName = name.trim();
    const trimmedTarget = target.trim();
    const problem = validateAlias(trimmedName, trimmedTarget);
    if (problem !== null) {
      setAliasError(ALIAS_ERRORS[problem]);
      return;
    }
    setAliasError('');
    put.mutate({ name: trimmedName, target: trimmedTarget });
  };

  const onDelete = (aliasName: string): void => {
    void confirm({
      title: `删除别名 ${aliasName}？`,
      description: '引用它的任务将无法解析运行时。',
      confirmLabel: '删除别名',
      destructive: true,
    }).then((confirmed) => {
      if (confirmed) remove.mutate(aliasName);
    });
  };

  const entries = aliases.data?.aliases ?? [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 @2xl/main:flex-row @2xl/main:items-end">
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor="alias-name">{ALIAS_NAME_LABEL}</Label>
          <Input
            id="alias-name"
            value={name}
            maxLength={64}
            spellCheck={false}
            autoComplete="off"
            placeholder={ALIAS_NAME_PLACEHOLDER}
            aria-describedby="alias-name-rule"
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="flex flex-[2] flex-col gap-1.5">
          <Label htmlFor="alias-target">{ALIAS_TARGET_LABEL}</Label>
          <Input
            id="alias-target"
            value={target}
            maxLength={512}
            spellCheck={false}
            autoComplete="off"
            placeholder={ALIAS_TARGET_PLACEHOLDER}
            onChange={(event) => setTarget(event.target.value)}
          />
        </div>
        <Button disabled={put.isPending || aliases.isPending} onClick={onSubmit}>{ALIAS_SUBMIT_LABEL}</Button>
        <Button
          variant="outline"
          disabled={aliases.isFetching}
          onClick={() => { void aliases.refetch(); }}
        >
          {ALIAS_REFRESH_LABEL}
        </Button>
      </div>
      <p id="alias-name-rule" className="text-sm text-muted-foreground">{ALIAS_NAME_RULE}</p>
      {aliasError !== '' && <p className="text-destructive" role="alert">{aliasError}</p>}

      {aliases.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : aliases.isError ? (
        <QueryError query={aliases} title="读取失败" />
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{ALIAS_EMPTY}</p>
      ) : (
        <ItemGroup>
          {entries.map((entry) => (
            <Item key={entry.name} variant="outline">
              <ItemContent>
                <ItemTitle><code>{entry.name}</code></ItemTitle>
                <ItemDescription><code>{entry.target}</code></ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button
                  variant="outline"
                  disabled={remove.isPending}
                  aria-label={`删除别名 ${entry.name}`}
                  onClick={() => onDelete(entry.name)}
                >
                  {ALIAS_DELETE_LABEL}
                </Button>
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      )}
    </div>
  );
}
