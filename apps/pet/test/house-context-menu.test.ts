import { describe, expect, it, vi } from 'vitest';
import { attachHouseContextMenu } from '../src/main/house-context-menu';

const { mockBuildFromTemplate, mockPopup } = vi.hoisted(() => {
  const mockPopup = vi.fn();
  const mockBuildFromTemplate = vi.fn((_template: unknown[]) => ({
    popup: mockPopup,
  }));
  return { mockBuildFromTemplate, mockPopup };
});

vi.mock('electron', () => ({
  Menu: { buildFromTemplate: mockBuildFromTemplate },
}));

describe('attachHouseContextMenu', () => {
  it('creates a settings and restart context menu and prevents default context menu', () => {
    const onRestart = vi.fn();
    const onOpenSettings = vi.fn();
    let storedHandler: (event: { preventDefault: () => void }, _params: unknown) => void;

    const win = {
      webContents: {
        on: vi.fn((_event: string, handler: typeof storedHandler) => {
          storedHandler = handler;
        }),
      },
    } as unknown as Electron.BrowserWindow;

    attachHouseContextMenu(win, { onRestart, onOpenSettings });

    const event = { preventDefault: vi.fn() };
    storedHandler!(event, {});

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(mockBuildFromTemplate).toHaveBeenCalledTimes(1);

    const template = mockBuildFromTemplate.mock.calls[0][0] as ({
      label?: string;
      type?: string;
      click?: () => void;
    })[];
    expect(template).toHaveLength(3);
    expect(template[0].label).toBe('设置');
    expect(template[1].type).toBe('separator');
    expect(template[2].label).toBe('重启');

    (template[0] as { click: () => void }).click();
    expect(onOpenSettings).toHaveBeenCalledTimes(1);

    (template[2] as { click: () => void }).click();
    expect(onRestart).toHaveBeenCalledTimes(1);

    expect(mockPopup).toHaveBeenCalledTimes(1);
    expect(mockPopup).toHaveBeenCalledWith({ window: win });
  });
});
