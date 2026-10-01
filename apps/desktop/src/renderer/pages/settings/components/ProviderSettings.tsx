import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { QueryError } from '@/renderer/components/query-error';
import { Button } from '@/renderer/components/ui/button';
import { Card, CardContent, CardDescription } from '@/renderer/components/ui/card';
import { Input } from '@/renderer/components/ui/input';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/renderer/components/ui/item';
import { Label } from '@/renderer/components/ui/label';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import { useConfirm } from '@/renderer/hooks/use-confirm';
import { shell } from '@/renderer/lib/desktop';
import { taskSettingsQuery } from '@/renderer/lib/queries';
import {
  ALIAS_DELETE_LABEL,
  ALIAS_DESCRIPTION,
  ALIAS_EMPTY,
  ALIAS_ERRORS,
  ALIAS_NAME_LABEL,
  ALIAS_NAME_PLACEHOLDER,
  ALIAS_NAME_RULE,
  ALIAS_REFRESH_LABEL,
  ALIAS_SUBMIT_LABEL,
  ALIAS_TARGET_LABEL,
  ALIAS_TARGET_PLACEHOLDER,
  ALIAS_TITLE,
  AUTO_CAP_DESCRIPTION,
  AUTO_CAP_FIELD_LABEL,
  AUTO_CAP_LOADING,
  AUTO_CAP_PLACEHOLDER,
  AUTO_CAP_RESET_LABEL,
  AUTO_CAP_SAVE_LABEL,
  AUTO_CAP_TITLE,
  AUTO_CAP_UNIT,
  AUTO_CAP_UNAVAILABLE,
  CONFLICT_MESSAGE,
  autoCapEffectiveText,
  autoCapErrorMessage,
} from '../model/describe.js';
import { autoCapDisplayValue, errorMessage, parseAutoCapInput, validateAlias } from '../model/settings.js';
import { runtimeAliasesQueryKey, useRuntimeAliasesQuery } from '../queries.js';

/**
 * Provider surface: the global auto-dispatch reference output cap and the
 * daemon-owned runtime alias store. Both write only through their existing
 * typed APIs and never invent a resolved provider/model triple.
 */
export function ProviderSettings() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const settings = useQuery(taskSettingsQuery());
  const aliases = useRuntimeAliasesQuery();
  const revision = settings.data?.revision ?? '';
  const capValue = settings.data?.user_global.max_auto_output_usd_per_million;

  const [capInput, setCapInput] = useState('');
  const [capDirty, setCapDirty] = useState(false);
  const [capStatus, setCapStatus] = useState('');
  const [capError, setCapError] = useState(false);

  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [aliasError, setAliasError] = useState('');

  useEffect(() => {
    if (settings.data && !capDirty) {
      setCapInput(autoCapDisplayValue(capValue));
    }
  }, [settings.data, capDirty, capValue]);

  const invalidateTaskSettings = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['taskSettings'] });
  };

  const capSave = useMutation({
    mutationFn: (value: number | null) => shell.saveTaskSettings({
      scope: 'global',
      expected_revision: revision,
      patch: { max_auto_output_usd_per_million: value },
    }),
    onSuccess: () => {
      setCapDirty(false);
      setCapStatus('已保存：全局自动派发参考输出单价上限已生效。');
      setCapError(false);
      invalidateTaskSettings();
    },
    onError: (error) => {
      const message = errorMessage(error);
      setCapStatus(message.includes('冲突') ? CONFLICT_MESSAGE : `保存失败：${message}`);
      setCapError(true);
      invalidateTaskSettings();
    },
  });

  const onCapSave = (): void => {
    const parsed = parseAutoCapInput(capInput);
    if (!parsed.ok) {
      setCapStatus(autoCapErrorMessage(parsed));
      setCapError(true);
      return;
    }
    setCapError(false);
    setCapStatus('');
    capSave.mutate(parsed.value);
  };

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

  const onAliasSubmit = (): void => {
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

  // Deleting an alias is irreversible for tasks that reference it, so it is
  // confirmed through the app's shared ConfirmHost (spec section 4.1, rule 3).
  const onAliasDelete = (aliasName: string): void => {
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
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-col gap-0.5">
            <span>{AUTO_CAP_TITLE}</span>
            <CardDescription>{AUTO_CAP_DESCRIPTION}</CardDescription>
          </div>
          <div className="flex items-end gap-2">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="provider-auto-cap">{AUTO_CAP_FIELD_LABEL}</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="provider-auto-cap"
                  type="number"
                  min={0}
                  step={0.5}
                  placeholder={AUTO_CAP_PLACEHOLDER}
                  value={capInput}
                  onChange={(event) => {
                    setCapDirty(true);
                    setCapStatus('');
                    setCapError(false);
                    setCapInput(event.target.value);
                  }}
                />
                <span className="text-muted-foreground whitespace-nowrap">{AUTO_CAP_UNIT}</span>
              </div>
            </div>
            <Button variant="outline" disabled={capSave.isPending || settings.isPending} onClick={() => capSave.mutate(null)}>
              {AUTO_CAP_RESET_LABEL}
            </Button>
            <Button disabled={capSave.isPending || settings.isPending} onClick={onCapSave}>
              {AUTO_CAP_SAVE_LABEL}
            </Button>
          </div>
          <p className="text-muted-foreground">
            {settings.isPending
              ? AUTO_CAP_LOADING
              : settings.isError
                ? AUTO_CAP_UNAVAILABLE
                : autoCapEffectiveText(capValue)}
          </p>
          {capStatus !== '' && (
            <p className={capError ? 'text-destructive' : 'text-muted-foreground'} role="status">
              {capStatus}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-0.5">
              <span>{ALIAS_TITLE}</span>
              <p className="text-muted-foreground">{ALIAS_DESCRIPTION}</p>
            </div>
            <Button
              variant="outline"
             
              disabled={aliases.isFetching}
              onClick={() => { void aliases.refetch(); }}
            >
              {ALIAS_REFRESH_LABEL}
            </Button>
          </div>

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
            <Button disabled={put.isPending || aliases.isPending} onClick={onAliasSubmit}>{ALIAS_SUBMIT_LABEL}</Button>
          </div>
          <p id="alias-name-rule" className="text-muted-foreground">{ALIAS_NAME_RULE}</p>
          {aliasError !== '' && <p className="text-destructive" role="alert">{aliasError}</p>}

          {aliases.isPending ? (
            <Skeleton className="h-16 w-full" />
          ) : aliases.isError ? (
            <QueryError query={aliases} title="读取失败" />
          ) : entries.length === 0 ? (
            <CardDescription>{ALIAS_EMPTY}</CardDescription>
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
                      onClick={() => onAliasDelete(entry.name)}
                    >
                      {ALIAS_DELETE_LABEL}
                    </Button>
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
