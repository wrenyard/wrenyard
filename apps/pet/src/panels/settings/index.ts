interface QuotaProviderEntry {
  id: string;
  enabled: boolean;
}

interface SettingsPayload {
  scale: number;
  bubbleSeconds: number;
  bottomOffset: number;
  entities: {
    house: boolean;
    workers: boolean;
  };
  appearance: {
    houseSkin: string;
  };
  quota: {
    providers: QuotaProviderEntry[];
  };
}

let currentConfig: SettingsPayload | null = null;
let hasUnsavedChanges = false;

function saveBtnState(): void {
  const saveBtn = document.getElementById('save-btn') as HTMLButtonElement | null;
  const restartBtn = document.getElementById('save-restart-btn') as HTMLButtonElement | null;
  if (saveBtn) saveBtn.disabled = !hasUnsavedChanges;
  if (restartBtn) restartBtn.disabled = !hasUnsavedChanges;
}

function markDirty(): void {
  hasUnsavedChanges = true;
  saveBtnState();
}

function renderSettings(config: SettingsPayload): void {
  currentConfig = config;
  hasUnsavedChanges = false;
  saveBtnState();

  setFieldValue('scale', String(config.scale));
  setFieldValue('bubble-seconds', String(config.bubbleSeconds));
  setFieldValue('bottom-offset', String(config.bottomOffset));

  const houseCheck = document.getElementById('show-house') as HTMLInputElement | null;
  if (houseCheck) houseCheck.checked = config.entities.house;

  const workersCheck = document.getElementById('show-workers') as HTMLInputElement | null;
  if (workersCheck) workersCheck.checked = config.entities.workers;

  // House skin
  const skinSelect = document.getElementById('house-skin') as HTMLSelectElement | null;
  if (skinSelect) {
    skinSelect.value = config.appearance?.houseSkin ?? 'classic';
  }

  // Read-only drag note
  const dragNote = document.getElementById('drag-note');
  if (dragNote) {
    dragNote.textContent = '房屋位置：拖动房屋窗口';
  }

  // Quota providers
  renderQuotaProviders(config.quota.providers);
}

function renderQuotaProviders(providers: QuotaProviderEntry[]): void {
  const container = document.getElementById('quota-providers');
  if (!container) return;
  container.innerHTML = '';

  providers.forEach((provider, idx) => {
    const row = document.createElement('div');
    row.className = 'quota-row';
    row.dataset.index = String(idx);

    // Enabled toggle
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = provider.enabled;
    toggle.className = 'quota-toggle';
    toggle.addEventListener('change', () => {
      const providers2 = currentConfig?.quota.providers ?? [];
      if (providers2[idx]) {
        providers2[idx].enabled = toggle.checked;
        markDirty();
      }
    });

    const label = document.createElement('span');
    label.className = 'quota-label';
    label.textContent = provider.id;

    // Up button
    const upBtn = document.createElement('button');
    upBtn.textContent = '▲';
    upBtn.className = 'quota-btn';
    upBtn.disabled = idx === 0;
    upBtn.addEventListener('click', () => {
      if (idx > 0) {
        const arr = currentConfig?.quota.providers ?? [];
        [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
        renderQuotaProviders(arr);
        markDirty();
      }
    });

    // Down button
    const downBtn = document.createElement('button');
    downBtn.textContent = '▼';
    downBtn.className = 'quota-btn';
    downBtn.disabled = idx === providers.length - 1;
    downBtn.addEventListener('click', () => {
      if (idx < providers.length - 1) {
        const arr = currentConfig?.quota.providers ?? [];
        [arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]];
        renderQuotaProviders(arr);
        markDirty();
      }
    });

    row.appendChild(toggle);
    row.appendChild(label);
    row.appendChild(upBtn);
    row.appendChild(downBtn);

    container.appendChild(row);
  });
}

function setFieldValue(id: string, value: string): void {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (el) el.value = value;
}

function getFieldValue(id: string): number {
  const el = document.getElementById(id) as HTMLInputElement | null;
  return el ? Number(el.value) : 0;
}

function collectPartial(): Record<string, unknown> {
  const skinSelect = document.getElementById('house-skin') as HTMLSelectElement | null;
  return {
    scale: getFieldValue('scale'),
    bubbleSeconds: getFieldValue('bubble-seconds'),
    bottomOffset: getFieldValue('bottom-offset'),
    entities: {
      house: (document.getElementById('show-house') as HTMLInputElement)?.checked ?? true,
      workers: (document.getElementById('show-workers') as HTMLInputElement)?.checked ?? true,
    },
    appearance: {
      houseSkin: skinSelect?.value ?? 'classic',
    },
    quota: {
      providers: currentConfig?.quota.providers ?? [],
    },
  };
}

async function saveSettings(): Promise<void> {
  const partial = collectPartial();
  const api = (window as any).settingsPanelApi;
  if (api?.save) {
    await api.save(partial);
    hasUnsavedChanges = false;
    saveBtnState();

    // Show saved confirmation briefly
    // Sync currentConfig with saved values so repeated edits reflect latest state
    currentConfig = {
      ...(currentConfig ?? {
        scale: 3,
        bubbleSeconds: 6,
        bottomOffset: 0,
        entities: { house: true, workers: true },
        appearance: { houseSkin: 'classic' },
        quota: { providers: [] },
      }),
      ...partial,
    } as SettingsPayload;

    const saveBtn = document.getElementById('save-btn') as HTMLButtonElement | null;
    if (saveBtn) {
      const originalText = saveBtn.textContent;
      saveBtn.textContent = '已保存 ✓';
      setTimeout(() => {
        saveBtn.textContent = originalText;
      }, 1500);
    }
  }
}

async function saveAndRestart(): Promise<void> {
  await saveSettings();
  const api = (window as any).settingsPanelApi;
  if (api?.saveAndRestart) {
    await api.saveAndRestart();
  }
}

async function init(): Promise<void> {
  const closeBtn = document.getElementById('close-btn');
  closeBtn?.addEventListener('click', () => {
    (window as any).panelClose?.();
  });

  const saveBtn = document.getElementById('save-btn');
  saveBtn?.addEventListener('click', saveSettings);

  const restartBtn = document.getElementById('save-restart-btn');
  restartBtn?.addEventListener('click', saveAndRestart);

  // Bind change events to mark dirty
  document.querySelectorAll('input, select').forEach((el) => {
    el.addEventListener('change', markDirty);
    el.addEventListener('input', markDirty);
  });

  // Load config
  const api = (window as any).settingsPanelApi;
  if (api?.load) {
    const config = await api.load();
    renderSettings(config as SettingsPayload);
  }
}

document.addEventListener('DOMContentLoaded', init);
