// Documentation screenshots (docs/images/). Run at --scale 2.
const RAIL = '[data-slot="sidebar-menu-button"]';

export default async function screenshots(ctx) {
  await ctx.appearance({ theme: 'paper', dark: false });
  await ctx.page('session');
  await ctx.sleep(1200);
  await ctx.shot('session');

  await ctx.click('[aria-label="上下文占用"]', { move: 1 });
  await ctx.click({ text: '展开明细' }, { move: 1 });
  await ctx.hideCursor();
  await ctx.sleep(600);
  await ctx.shot('context-meter');

  await ctx.click({ text: '在检查器中审计' }, { move: 1 });
  await ctx.hideCursor();
  await ctx.sleep(1200);
  await ctx.shot('context-inspector');
  await ctx.click('[aria-label="关闭检查器"]', { move: 1 });
  await ctx.hideCursor();

  await ctx.page('quota');
  await ctx.click({ text: '供应商', scope: '[role="tab"]' }, { move: 1 });
  await ctx.hideCursor();
  await ctx.sleep(600);
  await ctx.shot('providers');

  await ctx.page('stats');
  await ctx.click({ text: '7 天' }, { move: 1 });
  await ctx.hideCursor();
  await ctx.sleep(600);
  await ctx.shot('ledger');

  await ctx.page('settings');
  await ctx.click({ text: '外观', scope: RAIL }, { move: 1 });
  await ctx.hideCursor();
  await ctx.sleep(600);
  await ctx.shot('settings');

  await ctx.page('session');
  await ctx.appearance({ theme: 'paper', dark: true });
  await ctx.sleep(800);
  await ctx.shot('session-paper-dark');
  await ctx.appearance({ theme: 'neutral', dark: false });
  await ctx.sleep(800);
  await ctx.shot('session-neutral');
  await ctx.appearance({ theme: 'neutral', dark: true });
  await ctx.sleep(800);
  await ctx.shot('session-neutral-dark');
  await ctx.appearance({ theme: 'paper', dark: false });
}
