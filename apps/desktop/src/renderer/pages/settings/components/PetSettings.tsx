import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Input } from '@/renderer/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/components/ui/select';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import { Switch } from '@/renderer/components/ui/switch';
import { StatusBadge } from '@/renderer/components/status-badge';
import { shell } from '@/renderer/lib/desktop';
import type { PetCompanionSnapshot } from '@/shell-contract';
import {
  PET_DISPLAY_LABEL,
  PET_HOUSE_SKIN_LABEL,
  PET_SCALE_LABEL,
  PET_SHOW_HOUSE_LABEL,
  PET_SHOW_TASKGRAPHS_LABEL,
  PET_SHOW_WORKERS_LABEL,
  PET_BOTTOM_OFFSET_LABEL,
  PET_BUBBLE_SECONDS_LABEL,
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
import { PetApplyBar } from './PetApplyBar.js';

interface PetDraftState {
  pet: PetCompanionSnapshot | undefined;
  draft: PetDraft | null;
  dirty: boolean;
  failed: boolean;
  loading: boolean;
  update: (patch: Partial<PetDraft>) => void;
  reset: () => void;
}

const PetDraftContext = createContext<PetDraftState | null>(null);

function usePetDraft(): PetDraftState {
  const context = useContext(PetDraftContext);
  if (context === null) throw new Error('PetDraftContext missing');
  return context;
}

function PetNumberControl({ id, value, min, max, fallback, disabled, onChange }: {
  id: string;
  value: number;
  min: number;
  max: number;
  fallback: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <Input
      id={id}
      type="number"
      min={min}
      max={max}
      step={1}
      className="w-24"
      value={String(value)}
      disabled={disabled}
      onChange={(event) => {
        const next = event.target.valueAsNumber;
        if (!Number.isFinite(next)) return;
        onChange(clampPetNumber(next, min, max, fallback));
      }}
    />
  );
}

/**
 * Pet draft provider. Individual edits accumulate in a local draft; the payload
 * is sent only through the fixed `PetApplyBar`, so a background snapshot can
 * never reload the Pet window on its own (avoiding per-change flash).
 */
export function PetSettingsProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const settings = useSettingsQuery();
  const pet = settings.data?.pet;

  const [draft, setDraft] = useState<PetDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (pet && !dirty) {
      setDraft(petDraftFromSnapshot(pet));
      setFailed(false);
    }
  }, [pet, dirty]);

  const save = useMutation({
    mutationFn: (payload: PetDraft) => shell.savePetSettings(payload),
    onSuccess: (snapshot) => {
      queryClient.setQueryData(settingsQueryKey, snapshot);
      setDirty(false);
      setFailed(false);
    },
    onError: () => setFailed(true),
  });

  const state: PetDraftState = {
    pet,
    draft,
    dirty,
    failed,
    loading: settings.isPending || draft === null || pet === undefined,
    update: (patch) => {
      setDirty(true);
      setFailed(false);
      setDraft((current) => (current === null ? current : { ...current, ...patch }));
    },
    reset: () => {
      setDirty(false);
      setFailed(false);
      if (pet) setDraft(petDraftFromSnapshot(pet));
    },
  };

  return (
    <PetDraftContext.Provider value={state}>
      {children}
      <PetApplyBar
        dirty={dirty}
        applying={save.isPending}
        failed={failed}
        onApply={() => { if (draft) save.mutate(draft); }}
        onDiscard={() => state.reset()}
      />
    </PetDraftContext.Provider>
  );
}

/** Runtime status pill, rendered next to the Pet category heading. */
export function PetStatusBadge() {
  const settings = useSettingsQuery();
  const status = settings.data?.pet.status;
  if (status === undefined) return null;
  return <StatusBadge tone={petStatusTone(status)} label={petStatusLabel(status)} />;
}

export function PetEnabledControl() {
  const { draft, loading, update } = usePetDraft();
  if (loading || draft === null) return <Skeleton className="h-6 w-10" />;
  return <Switch checked={draft.enabled} onCheckedChange={(checked: boolean) => update({ enabled: checked })} />;
}

export function PetDisplayControl() {
  const { pet, draft, loading, update } = usePetDraft();
  if (loading || draft === null || pet === undefined) return <Skeleton className="h-8 w-52" />;
  return (
    <Select
      value={draft.displayId === undefined ? '' : String(draft.displayId)}
      onValueChange={(value) => update({ displayId: Number(value) })}
    >
      <SelectTrigger className="w-52" disabled={pet.displays.length === 0} aria-label={PET_DISPLAY_LABEL}>
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
  );
}

export function PetHouseSkinControl() {
  const { draft, loading, update } = usePetDraft();
  if (loading || draft === null) return <Skeleton className="h-8 w-52" />;
  return (
    <Select
      value={draft.appearance.houseSkin}
      onValueChange={(value) => {
        const skin = PET_HOUSE_SKINS.find((item) => item.value === value);
        if (skin) update({ appearance: { houseSkin: skin.value } });
      }}
    >
      <SelectTrigger className="w-52" aria-label={PET_HOUSE_SKIN_LABEL}>
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
  );
}

export function PetScaleControl() {
  const { draft, loading, update } = usePetDraft();
  if (loading || draft === null) return <Skeleton className="h-8 w-24" />;
  return (
    <PetNumberControl
      id="pet-scale"
      value={draft.scale}
      min={PET_SCALE_MIN}
      max={PET_SCALE_MAX}
      fallback={draft.scale}
      disabled={false}
      onChange={(value) => update({ scale: value })}
    />
  );
}

export function PetShowHouseControl() {
  const { draft, loading, update } = usePetDraft();
  if (loading || draft === null) return <Skeleton className="h-6 w-10" />;
  return (
    <Switch
      checked={draft.entities.house}
      onCheckedChange={(checked: boolean) => update({ entities: { ...draft.entities, house: checked } })}
    />
  );
}

export function PetShowWorkersControl() {
  const { draft, loading, update } = usePetDraft();
  if (loading || draft === null) return <Skeleton className="h-6 w-10" />;
  return (
    <Switch
      checked={draft.entities.workers}
      onCheckedChange={(checked: boolean) => update({ entities: { ...draft.entities, workers: checked } })}
    />
  );
}

export function PetShowTaskgraphsControl() {
  const { draft, loading, update } = usePetDraft();
  if (loading || draft === null) return <Skeleton className="h-6 w-10" />;
  return (
    <Switch
      checked={draft.entities.taskgraphs}
      onCheckedChange={(checked: boolean) => update({ entities: { ...draft.entities, taskgraphs: checked } })}
    />
  );
}

export function PetBottomOffsetControl() {
  const { draft, loading, update } = usePetDraft();
  if (loading || draft === null) return <Skeleton className="h-8 w-24" />;
  return (
    <PetNumberControl
      id="pet-bottom-offset"
      value={draft.bottomOffset}
      min={PET_BOTTOM_OFFSET_MIN}
      max={PET_BOTTOM_OFFSET_MAX}
      fallback={draft.bottomOffset}
      disabled={false}
      onChange={(value) => update({ bottomOffset: value })}
    />
  );
}

export function PetBubbleSecondsControl() {
  const { draft, loading, update } = usePetDraft();
  if (loading || draft === null) return <Skeleton className="h-8 w-24" />;
  return (
    <PetNumberControl
      id="pet-bubble-seconds"
      value={draft.bubbleSeconds}
      min={PET_BUBBLE_SECONDS_MIN}
      max={PET_BUBBLE_SECONDS_MAX}
      fallback={draft.bubbleSeconds}
      disabled={false}
      onChange={(value) => update({ bubbleSeconds: value })}
    />
  );
}
