// Promo clips: short scripted interactions recorded against the demo data.
// Each clip starts from a settled screen so the editor can cut between them.
const RAIL = '[data-slot="sidebar-menu-button"]';

export default async function promo(ctx) {
  await ctx.appearance({ theme: 'paper', dark: false });
  await ctx.page('session');
  await ctx.sleep(1200);

  await ctx.record('01-session', async () => {
    await ctx.sleep(600);
    await ctx.click({ text: '支付重试改为指数退避', scope: RAIL }, { move: 700 });
    await ctx.sleep(900);
    await ctx.click('textarea', { move: 800 });
    await ctx.type('再给重试加一个熔断：失败率超过 50% 时暂停 30 秒。', { cps: 12 });
    await ctx.sleep(400);
    await ctx.click('[aria-label="发送"]', { move: 500 });
    await ctx.hideCursor();
    await ctx.sleep(7500);
  });

  await ctx.record('02-meter', async () => {
    await ctx.sleep(400);
    await ctx.click('[aria-label="上下文占用"]', { move: 900 });
    await ctx.sleep(1800);
    await ctx.click({ text: '展开明细' }, { move: 600 });
    await ctx.sleep(2600);
    await ctx.key('Escape');
    await ctx.sleep(500);
  });

  await ctx.record('03-inspector', async () => {
    await ctx.click('[aria-label="上下文占用"]', { move: 700 });
    await ctx.sleep(900);
    await ctx.click({ text: '展开明细' }, { move: 500 });
    await ctx.sleep(700);
    await ctx.click({ text: '在检查器中审计' }, { move: 600 });
    await ctx.sleep(1600);
    await ctx.scroll({ x: 1240, y: 520 }, 520, { duration: 1600 });
    await ctx.sleep(1400);
  });

  await ctx.record('04-statusbar', async () => {
    await ctx.click('[aria-label="任务活动"]', { move: 900 });
    await ctx.sleep(2600);
    await ctx.key('Escape');
    await ctx.click('[aria-label="额度"]', { move: 900 });
    await ctx.sleep(2800);
    await ctx.key('Escape');
    await ctx.sleep(400);
  });

  await ctx.record('05-quota', async () => {
    await ctx.click({ text: '模型供应', scope: RAIL }, { move: 800 });
    await ctx.sleep(700);
    await ctx.click({ text: '供应商', scope: '[role="tab"]' }, { move: 600 });
    await ctx.sleep(1200);
    await ctx.moveTo({ x: 640, y: 210 }, 900);
    await ctx.sleep(1800);
  });

  await ctx.record('06-stats', async () => {
    await ctx.click({ text: '工房台账', scope: RAIL }, { move: 700 });
    await ctx.sleep(1400);
    await ctx.click({ text: '7 天' }, { move: 900 });
    await ctx.sleep(1500);
    await ctx.click({ text: '1 个月' }, { move: 500 });
    await ctx.sleep(1500);
  });

  await ctx.record('07-themes', async () => {
    await ctx.click({ text: '设置', scope: RAIL }, { move: 800 });
    await ctx.sleep(500);
    await ctx.click({ text: '外观', scope: RAIL }, { move: 600 });
    await ctx.sleep(900);
    await ctx.click({ text: '简约' }, { move: 700 });
    await ctx.sleep(1300);
    await ctx.click({ text: '深色' }, { move: 700 });
    await ctx.sleep(1400);
    await ctx.click({ text: '纸本' }, { move: 700 });
    await ctx.sleep(1600);
    await ctx.hideCursor();
    await ctx.page('session');
    await ctx.sleep(1800);
  });

  await ctx.appearance({ theme: 'paper', dark: false });
}
