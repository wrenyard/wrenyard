import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { QueryError } from '@/renderer/components/query-error';
import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/renderer/components/ui/item';
import { Label } from '@/renderer/components/ui/label';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import { useConfirm } from '@/renderer/hooks/use-confirm';
import { shell } from '@/renderer/lib/desktop';
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
} from '../model/describe.js';
import {
  errorMessage,
  validateAlias,
} from '../model/settings.js';
import { runtimeAliasesQueryKey, useRuntimeAliasesQuery } from '../queries.js';

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
