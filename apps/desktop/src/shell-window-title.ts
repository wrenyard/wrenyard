import type { ShellPage } from './shell-contract.js';

const PRODUCT_TITLE = '啾啾工坊';

export function formatShellWindowTitle(page: ShellPage, appVersion: string): string {
  const productTitle = `${PRODUCT_TITLE} v${appVersion}`;
  if (page === 'workbench') return productTitle;
  const pageTitle = page === 'stats' ? '工房台账' : page === 'quota' ? '模型供应' : page === 'clients' ? '客户端' : page === 'tasks' ? '任务' : '设置';
  return `${pageTitle} — ${productTitle}`;
}
