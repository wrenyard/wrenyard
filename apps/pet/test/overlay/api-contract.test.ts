import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const rootDir = process.cwd();

describe('overlay PetApi contract', () => {
  it('keeps the exact method surface and subscription return shape', () => {
    const source = fs.readFileSync(path.join(rootDir, 'src/overlay/api/pet-api.ts'), 'utf8');
    expect(source).toContain('onSnapshot(cb: (snap: SiteSnapshot) => void): () => void;');
    expect(source).toContain('onHouseUpdate(cb: (state: HouseRendererState) => void): () => void;');
    expect(source).toContain('onWorkerUpdate(cb: (state: WorkerRendererState) => void): () => void;');
    expect(source).toContain('getConfig(): Promise<RendererConfig>;');
    expect(source).toContain('setHouseMousePassthrough(passthrough: boolean): void;');
    expect(source).toContain('getHouseCursorPoint(): Promise<{ x: number; y: number; inside: boolean } | null>;');
    expect(source).toContain('houseDragStart(): void;');
    expect(source).toContain('houseDragMove(): void;');
    expect(source).toContain('houseDragEnd(): void;');
    expect(source).toContain('dismissBroadcast(id?: string): void;');
    expect(source).toContain('setWorkerMousePassthrough(id: string, passthrough: boolean): void;');
    expect(source).toContain('workerDragStart(id: string): void;');
    expect(source).toContain('workerDragMove(id: string): void;');
    expect(source).toContain('workerDragEnd(id: string): void;');
    expect(source).toContain('openSettings(): Promise<void>;');
    expect(source).toContain('openStats(): Promise<void>;');
    expect(source).toContain('petApi: PetApi;');
    expect(source).toContain('settingsPanelApi: SettingsPanelApi;');
    expect(source).not.toContain('login');
    expect(source).toContain('statsPanelApi: StatsPanelApi;');
    expect(source).toContain('panelClose: () => void;');
    expect(source).toContain("from '../../shared/entities'");
    expect(source).toContain("from '../../shared/snapshot'");
  });

  it('keeps preload channel names and unsubscribe listener removal unchanged', () => {
    const source = fs.readFileSync(path.join(rootDir, 'src/main/preload.ts'), 'utf8');
    for (const channel of ['site:snapshot', 'house:update', 'worker:update']) {
      expect(source).toContain(`ipcRenderer.on('${channel}', handler)`);
      expect(source).toContain(`ipcRenderer.removeListener('${channel}', handler)`);
    }
    expect(source).toContain("ipcRenderer.invoke('get-config')");
    expect(source).toContain("ipcRenderer.sendSync('house:mouse-passthrough', passthrough)");
    expect(source).toContain("ipcRenderer.invoke('house:get-cursor-point')");
    expect(source).toContain("ipcRenderer.send('house:drag-start')");
    expect(source).toContain("ipcRenderer.send('house:drag-move')");
    expect(source).toContain("ipcRenderer.send('house:drag-end')");
    expect(source).toContain("ipcRenderer.send('house:broadcast-dismiss', id)");
    expect(source).toContain("ipcRenderer.send('worker:mouse-passthrough', id, passthrough)");
    expect(source).toContain("ipcRenderer.send('worker:drag-start', id)");
    expect(source).toContain("ipcRenderer.send('worker:drag-move', id)");
    expect(source).toContain("ipcRenderer.send('worker:drag-end', id)");
  });

  it('exposes panel IPC channels in preload', () => {
    const source = fs.readFileSync(path.join(rootDir, 'src/main/preload.ts'), 'utf8');
    expect(source).toContain("ipcRenderer.invoke('settings:load')");
    expect(source).toMatch(/ipcRenderer\.invoke\('settings:save'/);
    expect(source).toContain("ipcRenderer.invoke('settings:save-and-restart')");
    expect(source).not.toContain("ipcRenderer.invoke('settings:login')");
    expect(source).toContain("ipcRenderer.invoke('stats:load')");
    expect(source).not.toContain("ipcRenderer.invoke('stats:refresh')");
    expect(source).toContain("ipcRenderer.invoke('house:open-settings')");
    expect(source).toContain("ipcRenderer.invoke('house:open-stats')");
    expect(source).toContain("ipcRenderer.send('panel:close')");
  });

  it('acknowledges sendSync passthrough contract with setIgnoreMouseEvents', () => {
    const source = fs.readFileSync(path.join(rootDir, 'src/main/index.ts'), 'utf8');
    // The main handler must call setIgnoreMouseEvents before returning ack
    const passthroughHandlerStart = source.indexOf("ipcMain.on('house:mouse-passthrough'");
    expect(passthroughHandlerStart).toBeGreaterThanOrEqual(0);

    const handlerBlock = source.slice(passthroughHandlerStart, passthroughHandlerStart + 600);
    expect(handlerBlock).toContain('setIgnoreMouseEvents');
    expect(handlerBlock).toContain('event.returnValue = { ack: true }');
    // setIgnoreMouseEvents must appear before the ack assignment
    const setIgnoreIdx = handlerBlock.indexOf('setIgnoreMouseEvents');
    const ackIdx = handlerBlock.indexOf('event.returnValue = { ack: true }');
    expect(setIgnoreIdx).toBeGreaterThan(0);
    expect(ackIdx).toBeGreaterThan(setIgnoreIdx);
  });
});
