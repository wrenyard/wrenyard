import type { ShellPage } from './shell-contract.js';

const PRODUCT_TITLE = '啾啾工坊';
const SOURCE_DEVELOPMENT_SUFFIX = '（开发模式）';

export function formatShellWindowTitle(page: ShellPage, appVersion: string, sourceDevelopment: boolean): string {
  const productTitle = `${PRODUCT_TITLE} v${appVersion}${sourceDevelopment ? SOURCE_DEVELOPMENT_SUFFIX : ''}`;
  if (page === 'session') return productTitle;
  const pageTitle = page === 'stats' ? '工房台账' : page === 'quota' ? '模型供应' : page === 'tasks' ? '任务' : '设置';
  return `${pageTitle} — ${productTitle}`;
}
