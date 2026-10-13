// ── Mini card windows ────────────────────────────────────────────────
// Owns the frameless desktop "card" windows the shell turns into while the
// main window is hidden. Each card is an always-on-top small conversation
// window loading the same shell page with `?mini=1&session=<id>`, so one
// renderer build serves both the full shell and every card. The shell hides
// when a card opens from it and returns once the last card closes.

import { BrowserWindow, screen, type WebContents } from 'electron';
import type { PageLoader } from './pages.js';
import { shellWebPreferences } from './shell-window.js';

/** Card geometry: a small desktop conversation card. */
const CARD_WIDTH = 380;
const CARD_HEIGHT = 560;
const CARD_MIN_WIDTH = 300;
const CARD_MIN_HEIGHT = 360;
/** Cascade offset for a card opened from another card. */
const CARD_OFFSET = 24;

export interface MiniCardManagerOptions {
  pageLoader: PageLoader;
  preloadPath: string;
  backgroundColor: string;
  additionalArguments: string[];
  /** The live shell window, or null when it is gone. */
  getShellWindow(): BrowserWindow | null;
  /** Hide the shell when a card is opened from it. */
  hideShell(): void;
  /** Show and focus the shell (last card closed, or an explicit return). */
  showShell(): void;
  /** Ask the shell renderer to open a session ('' selects a new draft). */
  selectShellSession(sessionId: string): void;
  logger?: Pick<Console, 'info' | 'warn'>;
}

interface CardState {
  window: BrowserWindow;
  /** Per-card 置顶 flag; pinned means always-on-top (default on). */
  pinned: boolean;
}

/**
 * Owns the mini-card windows and their trust edge: `isCardSender` is the only
 * way an open card joins the shared shell-surface predicate, and a card is
 * removed the moment it closes, so a stale id can never retain trust.
 */
export class MiniCardManager {
  private readonly cards = new Map<number, CardState>();
  private readonly log: Pick<Console, 'info' | 'warn'>;

  constructor(private readonly options: MiniCardManagerOptions) {
    this.log = options.logger ?? console;
  }

  /** Whether `sender` is the web contents of a currently open card. */
  isCardSender(sender: WebContents): boolean {
    const card = this.cards.get(sender.id);
    return card !== undefined && card.window.webContents === sender;
  }

  /** Every live card web contents, for the session-event broadcast. */
  cardWebContents(): WebContents[] {
    const contents: WebContents[] = [];
    for (const card of this.cards.values()) {
      if (!card.window.isDestroyed() && !card.window.webContents.isDestroyed()) {
        contents.push(card.window.webContents);
      }
    }
    return contents;
  }

  /**
   * Open a card for a session ('' means a new draft). Opened from the shell it
   * sits at the shell's top-right corner and hides the shell; opened from a card
   * it cascades off that card. Both are clamped to the display work area.
   */
  openCard(sessionId: string, sender: WebContents): void {
    const shell = this.options.getShellWindow();
    const fromShell = shell !== null && shell.webContents === sender;
    const anchor = fromShell ? shell : BrowserWindow.fromWebContents(sender);
    const win = new BrowserWindow({
      ...this.placeCard(anchor, fromShell),
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      minWidth: CARD_MIN_WIDTH,
      minHeight: CARD_MIN_HEIGHT,
      frame: false,
      resizable: true,
      show: false,
      backgroundColor: this.options.backgroundColor,
      webPreferences: shellWebPreferences(this.options.preloadPath, this.options.additionalArguments),
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    const id = win.webContents.id;
    this.cards.set(id, { window: win, pinned: true });
    // A card is a general Desktop window: never open a child window and never
    // navigate away from the shell page.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, targetUrl) => {
      if (targetUrl.split('#', 1)[0] !== this.options.pageLoader.url('shell')) event.preventDefault();
    });
    // Re-assert the pinned z-order when another window takes focus, without
    // stealing focus back (no focus()/show()).
    win.on('blur', () => this.reassertOnTop(id));
    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) win.show();
    });
    win.on('closed', () => this.handleClosed(id));
    void this.options.pageLoader
      .load(win, 'shell', { mini: '1', session: sessionId })
      .catch((error: unknown) => {
        this.log.warn('[wrenyard-desktop] mini card failed to load:', error);
        if (!win.isDestroyed()) win.close();
      });
    if (fromShell) this.options.hideShell();
    this.log.info(`[wrenyard-desktop] mini card opened (session=${sessionId || 'draft'})`);
  }

  /** Apply a card's 置顶 switch; unpinning drops back to the normal level. */
  setAlwaysOnTop(sender: WebContents, enabled: boolean): void {
    const card = this.cards.get(sender.id);
    if (!card || card.window.isDestroyed()) return;
    card.pinned = enabled;
    if (enabled) card.window.setAlwaysOnTop(true, 'screen-saver');
    else card.window.setAlwaysOnTop(false);
  }

  /** Close only this card; the shell returns if it was the last one. */
  closeCard(sender: WebContents): void {
    const card = this.cards.get(sender.id);
    if (card && !card.window.isDestroyed()) card.window.close();
  }

  /** Close this card and bring the shell back, opened to `sessionId`. */
  restoreMain(sender: WebContents, sessionId: string): void {
    const card = this.cards.get(sender.id);
    if (card && !card.window.isDestroyed()) card.window.close();
    this.options.showShell();
    this.options.selectShellSession(sessionId);
  }

  private reassertOnTop(id: number): void {
    const card = this.cards.get(id);
    if (!card || card.window.isDestroyed() || !card.pinned) return;
    card.window.setAlwaysOnTop(true, 'screen-saver');
    card.window.moveTop();
  }

  private handleClosed(id: number): void {
    this.cards.delete(id);
    if (this.cards.size > 0) return;
    const shell = this.options.getShellWindow();
    // The shell may already be shown (an explicit 回到主窗口); only re-show it
    // when it is hidden and this was the last card.
    if (!shell || shell.isVisible()) return;
    this.options.showShell();
  }

  /** The card's top-left corner, cascaded from its anchor and clamped on-screen. */
  private placeCard(anchor: BrowserWindow | null, fromShell: boolean): { x: number; y: number } {
    const bounds = anchor?.getBounds();
    const desired = bounds
      ? fromShell
        ? { x: bounds.x + bounds.width - CARD_WIDTH, y: bounds.y }
        : { x: bounds.x + CARD_OFFSET, y: bounds.y + CARD_OFFSET }
      : { x: 0, y: 0 };
    const area = screen.getDisplayMatching(
      bounds ?? { x: desired.x, y: desired.y, width: CARD_WIDTH, height: CARD_HEIGHT },
    ).workArea;
    return {
      x: Math.min(Math.max(desired.x, area.x), area.x + area.width - CARD_WIDTH),
      y: Math.min(Math.max(desired.y, area.y), area.y + area.height - CARD_HEIGHT),
    };
  }
}
