import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/renderer/components/ui/button';
import { Card, CardContent, CardDescription, CardTitle } from '@/renderer/components/ui/card';
import { Input } from '@/renderer/components/ui/input';
import { Label } from '@/renderer/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/components/ui/select';
import { Separator } from '@/renderer/components/ui/separator';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import { Switch } from '@/renderer/components/ui/switch';
import { StatusBadge } from '@/renderer/components/status-badge';
import { savePetSettings } from '@/renderer/lib/desktop';
import {
  PET_BEHAVIOR_TITLE,
  PET_BOTTOM_OFFSET_HINT,
  PET_BOTTOM_OFFSET_LABEL,
  PET_BUBBLE_SECONDS_HINT,
  PET_BUBBLE_SECONDS_LABEL,
  PET_CLEAN_NOTE,
  PET_DIRTY_NOTE,
  PET_DISPLAY_CONTENT_TITLE,
  PET_DISPLAY_HINT,
  PET_DISPLAY_LABEL,
  PET_ENABLED_HINT,
  PET_ENABLED_LABEL,
  PET_HOUSE_SKIN_HINT,
  PET_HOUSE_SKIN_LABEL,
  PET_SAVE_FAILED_NOTE,
  PET_SAVE_LABEL,
  PET_SAVING_LABEL,
  PET_SCALE_HINT,
  PET_SCALE_LABEL,
  PET_SHOW_HOUSE_HINT,
  PET_SHOW_HOUSE_LABEL,
  PET_SHOW_TASKGRAPHS_HINT,
  PET_SHOW_TASKGRAPHS_LABEL,
  PET_SHOW_WORKERS_HINT,
  PET_SHOW_WORKERS_LABEL,
  petStatusLabel,
  petStatusTone,
} from '../model/describe.js';
import {
  PET_BOTTOM_OFFSET_MAX,
  PET_BOTTOM_OFFSET_MIN,
  PET_BUBBLE_SECONDS_MAX,
  PET_BUBBLE_SECONDS_MIN,
  PET_HOUSE_SKINS,
  PET_SCALE_MAX,
  PET_SCALE_MIN,
  clampPetNumber,
  petDraftFromSnapshot,
  type PetDraft,
} from '../model/settings.js';
import { settingsQueryKey, useSettingsQuery } from '../queries.js';

function PetRow({ id, label, hint, children }: {
  id?: string;
  label: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex flex-col gap-0.5">
        <Label htmlFor={id}>{label}</Label>
        <CardDescription>{hint}</CardDescription>
      </div>
      {children}
    </div>
  );
}

/**
 * Pet companion form. Every control edits a local draft; the payload is sent
 * only through an explicit "保存并应用" and only when something changed, so a
 * background snapshot refresh can never apply a pet change on its own.
 */
export function PetSettings() {
  const queryClient = useQueryClient();
  const settings = useSettingsQuery();
  const pet = settings.data?.pet;

  const [draft, setDraft] = useState<PetDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState(PET_CLEAN_NOTE);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (pet && !dirty) {
      setDraft(petDraftFromSnapshot(pet));
      setNote(PET_CLEAN_NOTE);
      setFailed(false);
    }
  }, [pet, dirty]);

  const save = useMutation({
    mutationFn: (payload: PetDraft) => savePetSettings(payload),
    onSuccess: (snapshot) => {
      queryClient.setQueryData(settingsQueryKey, snapshot);
      setDirty(false);
      setNote(PET_CLEAN_NOTE);
      setFailed(false);
    },
    onError: () => {
      setFailed(true);
      setNote(PET_SAVE_FAILED_NOTE);
    },
  });

  if (settings.isPending || draft === null || pet === undefined) {
    return (
      <Card>
        <CardContent className="flex flex-col gap-4">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-40 w-full" />
        </CardContent>
      </Card>
    );
  }

  const markDirty = (): void => {
    setDirty(true);
    setNote(PET_DIRTY_NOTE);
    setFailed(false);
  };

  const update = (patch: Partial<PetDraft>): void => {
    markDirty();
    setDraft({ ...draft, ...patch });
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4">
            <span>状态</span>
            <StatusBadge tone={petStatusTone(pet.status)} label={petStatusLabel(pet.status)} />
          </div>
          <Separator />
          <PetRow id="pet-enabled" label={PET_ENABLED_LABEL} hint={PET_ENABLED_HINT}>
            <Switch id="pet-enabled" checked={draft.enabled} onCheckedChange={(checked) => update({ enabled: checked })} />
          </PetRow>
          <PetRow id="pet-display" label={PET_DISPLAY_LABEL} hint={PET_DISPLAY_HINT}>
            <Select
              value={draft.displayId === undefined ? '' : String(draft.displayId)}
              onValueChange={(value) => update({ displayId: Number(value) })}
            >
              <SelectTrigger id="pet-display" className="w-52" disabled={pet.displays.length === 0} aria-label={PET_DISPLAY_LABEL}>
                <SelectValue>
                  {(value) => pet.displays.find((item) => String(item.id) === value)?.label ?? value}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {pet.displays.map((item) => (
                  <SelectItem key={item.id} value={String(item.id)}>
                    {item.isPrimary ? `${item.label}（主显示器）` : item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </PetRow>
          <PetRow id="pet-house-skin" label={PET_HOUSE_SKIN_LABEL} hint={PET_HOUSE_SKIN_HINT}>
            <Select
              value={draft.appearance.houseSkin}
              onValueChange={(value) => {
                const skin = PET_HOUSE_SKINS.find((item) => item.value === value);
                if (skin) update({ appearance: { houseSkin: skin.value } });
              }}
            >
              <SelectTrigger id="pet-house-skin" className="w-52" aria-label={PET_HOUSE_SKIN_LABEL}>
                <SelectValue>
                  {(value) => PET_HOUSE_SKINS.find((item) => item.value === value)?.label ?? value}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {PET_HOUSE_SKINS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </PetRow>
          <PetRow id="pet-scale" label={PET_SCALE_LABEL} hint={PET_SCALE_HINT}>
            <Input
              id="pet-scale"
              type="number"
              min={PET_SCALE_MIN}
              max={PET_SCALE_MAX}
              step={1}
              className="w-24"
              value={String(draft.scale)}
              onChange={(event) => {
                const value = event.target.valueAsNumber;
                if (!Number.isFinite(value)) return;
                update({ scale: clampPetNumber(value, PET_SCALE_MIN, PET_SCALE_MAX, draft.scale) });
              }}
            />
          </PetRow>
        </CardContent>
      </Card>

      <div>
        <CardTitle className="mb-2">{PET_DISPLAY_CONTENT_TITLE}</CardTitle>
        <Card>
          <CardContent className="flex flex-col gap-4">
            <PetRow label={PET_SHOW_HOUSE_LABEL} hint={PET_SHOW_HOUSE_HINT}>
              <Switch checked={draft.entities.house} onCheckedChange={(checked) => update({ entities: { ...draft.entities, house: checked } })} />
            </PetRow>
            <PetRow label={PET_SHOW_WORKERS_LABEL} hint={PET_SHOW_WORKERS_HINT}>
              <Switch checked={draft.entities.workers} onCheckedChange={(checked) => update({ entities: { ...draft.entities, workers: checked } })} />
            </PetRow>
            <PetRow label={PET_SHOW_TASKGRAPHS_LABEL} hint={PET_SHOW_TASKGRAPHS_HINT}>
              <Switch checked={draft.entities.taskgraphs} onCheckedChange={(checked) => update({ entities: { ...draft.entities, taskgraphs: checked } })} />
            </PetRow>
          </CardContent>
        </Card>
      </div>

      <div>
        <CardTitle className="mb-2">{PET_BEHAVIOR_TITLE}</CardTitle>
        <Card>
          <CardContent className="flex flex-col gap-4">
            <PetRow id="pet-bottom-offset" label={PET_BOTTOM_OFFSET_LABEL} hint={PET_BOTTOM_OFFSET_HINT}>
              <Input
                id="pet-bottom-offset"
                type="number"
                min={PET_BOTTOM_OFFSET_MIN}
                max={PET_BOTTOM_OFFSET_MAX}
                step={1}
                className="w-24"
                value={String(draft.bottomOffset)}
                onChange={(event) => {
                  const value = event.target.valueAsNumber;
                  if (!Number.isFinite(value)) return;
                  update({ bottomOffset: clampPetNumber(value, PET_BOTTOM_OFFSET_MIN, PET_BOTTOM_OFFSET_MAX, draft.bottomOffset) });
                }}
              />
            </PetRow>
            <PetRow id="pet-bubble-seconds" label={PET_BUBBLE_SECONDS_LABEL} hint={PET_BUBBLE_SECONDS_HINT}>
              <Input
                id="pet-bubble-seconds"
                type="number"
                min={PET_BUBBLE_SECONDS_MIN}
                max={PET_BUBBLE_SECONDS_MAX}
                step={1}
                className="w-24"
                value={String(draft.bubbleSeconds)}
                onChange={(event) => {
                  const value = event.target.valueAsNumber;
                  if (!Number.isFinite(value)) return;
                  update({ bubbleSeconds: clampPetNumber(value, PET_BUBBLE_SECONDS_MIN, PET_BUBBLE_SECONDS_MAX, draft.bubbleSeconds) });
                }}
              />
            </PetRow>
          </CardContent>
        </Card>
      </div>

      <div className="flex items-center justify-between gap-3">
        <span className={failed ? 'text-destructive' : 'text-muted-foreground'} role="status">{note}</span>
        <Button disabled={!dirty || save.isPending} onClick={() => save.mutate(draft)}>
          {save.isPending ? PET_SAVING_LABEL : PET_SAVE_LABEL}
        </Button>
      </div>
    </div>
  );
}
