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
  /** The shell's current interface zoom factor (100% → 1). */
  getZoomFactor(): number;
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
  /** Card ids by focus recency: the most recently focused card is last. */
  private readonly focusOrder: number[] = [];
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

  /** Re-apply an interface zoom factor to every open card (on zoom change). */
  applyZoomToCards(factor: number): void {
    for (const card of this.cards.values()) {
      if (card.window.isDestroyed()) continue;
      this.applyCardZoom(card.window, factor);
      // Keep each card's minimum size on the same scale; never resize a card
      // that is already open.
      card.window.setMinimumSize(
        Math.round(CARD_MIN_WIDTH * factor),
        Math.round(CARD_MIN_HEIGHT * factor),
      );
    }
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
    // Match the shell's interface zoom: scale the default and minimum sizes by
    // the zoom factor so the card keeps the shell's proportions.
    const zoom = this.options.getZoomFactor();
    const width = Math.round(CARD_WIDTH * zoom);
    const height = Math.round(CARD_HEIGHT * zoom);
    const win = new BrowserWindow({
      ...this.placeCard(anchor, fromShell, width, height),
      width,
      height,
      minWidth: Math.round(CARD_MIN_WIDTH * zoom),
      minHeight: Math.round(CARD_MIN_HEIGHT * zoom),
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
    // Re-assert the pinned z-order only when focus leaves the app entirely
    // (e.g. a running game), never when focus moves between our own windows
    // (another card or the shell). Never steals focus back (no focus()/show()).
    win.on('blur', () => this.reassertOnTop());
    // Raise the focused card above the other pinned cards at the same level.
    win.on('focus', () => this.raiseCard(id));
    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) win.show();
    });
    win.on('closed', () => this.handleClosed(id));
    void this.options.pageLoader
      .load(win, 'shell', { mini: '1', session: sessionId })
      // Apply the shell's zoom once the page is loaded: Chromium resets a
      // webContents' zoom on navigation, so setting it before load is lost.
      .then(() => { this.applyCardZoom(win, zoom); })
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

  private reassertOnTop(): void {
    // Defer until the focus change settles: the blur may be caused by another
    // one of our windows (another card or the shell) taking focus.
    setImmediate(() => {
      // Only re-assert when focus left the app entirely (e.g. a running game);
      // any focused window of this app (another card, the shell, a Pet window)
      // means another surface owns the top.
      if (BrowserWindow.getFocusedWindow() !== null) return;
      // Re-assert every pinned card, least-recently-focused first, so the most
      // recently focused card ends on top. Never steals focus (no focus()/show()).
      const ordered = [...this.cards.entries()].sort(
        ([a], [b]) => this.focusOrder.indexOf(a) - this.focusOrder.indexOf(b),
      );
      for (const [, card] of ordered) {
        if (card.window.isDestroyed() || !card.pinned) continue;
        card.window.setAlwaysOnTop(true, 'screen-saver');
        card.window.moveTop();
      }
    });
  }

  private raiseCard(id: number): void {
    const card = this.cards.get(id);
    if (!card || card.window.isDestroyed()) return;
    if (card.pinned) card.window.setAlwaysOnTop(true, 'screen-saver');
    // Track focus order: the most recently focused card is last, so a later
    // re-assert stacks the cards in the order the user last focused them.
    const index = this.focusOrder.indexOf(id);
    if (index !== -1) this.focusOrder.splice(index, 1);
    this.focusOrder.push(id);
    card.window.moveTop();
  }

  /** Apply an interface zoom factor to one card (best-effort). */
  private applyCardZoom(win: BrowserWindow, factor: number): void {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    try {
      win.webContents.setZoomFactor(factor);
    } catch {
      // Zoom is best-effort; the card keeps its current factor.
    }
  }

  private handleClosed(id: number): void {
    this.cards.delete(id);
    const index = this.focusOrder.indexOf(id);
    if (index !== -1) this.focusOrder.splice(index, 1);
    if (this.cards.size > 0) return;
    const shell = this.options.getShellWindow();
    // The shell may already be shown (an explicit 回到主窗口); only re-show it
    // when it is hidden and this was the last card.
    if (!shell || shell.isVisible()) return;
    this.options.showShell();
  }

  /** The card's top-left corner, cascaded from its anchor and clamped on-screen. */
  private placeCard(
    anchor: BrowserWindow | null,
    fromShell: boolean,
    width: number,
    height: number,
  ): { x: number; y: number } {
    const bounds = anchor?.getBounds();
    const desired = bounds
      ? fromShell
        ? { x: bounds.x + bounds.width - width, y: bounds.y }
        : { x: bounds.x + CARD_OFFSET, y: bounds.y + CARD_OFFSET }
      : { x: 0, y: 0 };
    const area = screen.getDisplayMatching(
      bounds ?? { x: desired.x, y: desired.y, width, height },
    ).workArea;
    return {
      x: Math.min(Math.max(desired.x, area.x), area.x + area.width - width),
      y: Math.min(Math.max(desired.y, area.y), area.y + area.height - height),
    };
  }
}
