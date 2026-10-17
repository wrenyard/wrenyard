// Documentation screenshots (docs/images/). Run at --scale 2.
const RAIL = '[data-slot="sidebar-menu-button"]';

export default async function screenshots(ctx) {
  await ctx.appearance({ theme: 'paper', dark: false });
  await ctx.page('session');
  await ctx.sleep(1200);
  await ctx.click('[aria-label="对话视图"]', { move: 1 });
  await ctx.hideCursor();
  await ctx.shot('hero');

  await ctx.click('[aria-label="上下文占用"]', { move: 1 });
  await ctx.hideCursor();
  await ctx.sleep(800);
  await ctx.shot('context-meter');
  await ctx.click('[aria-label="上下文占用"]', { move: 1 });

  await ctx.click('[aria-label="详细视图"]', { move: 1 });
  await ctx.hideCursor();
  await ctx.sleep(1200);
  // Start the detailed view at the first turn, where the tasks fan out.
  await ctx.evaluate(`for (const el of document.querySelectorAll('main *')) {
    if (el.scrollHeight > el.clientHeight + 8 && getComputedStyle(el).overflowY !== 'visible') el.scrollTop = 0;
  }`);
  await ctx.sleep(600);
  await ctx.shot('transcript');
  await ctx.click('[aria-label="对话视图"]', { move: 1 });
  await ctx.hideCursor();

  await ctx.page('agents');
  await ctx.hideCursor();
  await ctx.sleep(1500);
  await ctx.shot('agents');

  await ctx.page('settings');
  await ctx.click({ text: '供应商', scope: RAIL }, { move: 1 });
  await ctx.hideCursor();
  await ctx.sleep(800);
  await ctx.shot('providers');

  await ctx.page('stats');
  await ctx.click({ text: '7 天' }, { move: 1 });
  await ctx.hideCursor();
  await ctx.sleep(800);
  await ctx.shot('ledger');

  await ctx.page('settings');
  await ctx.click({ text: '外观', scope: RAIL }, { move: 1 });
  await ctx.hideCursor();
  await ctx.sleep(800);
  await ctx.shot('themes');

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
