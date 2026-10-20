/**
 * WorkBuddy API contract derived from MIT reference implementations:
 * - magpie-community/plugins packages/workbuddy @ 68170b3ebe747127c96f03339fb55ebf6a15d151
 * - yetone/magpie internal/provider/workbuddy.go @ 761556a0
 */

export type WorkBuddyBuildId = 'workbuddy' | 'workbuddy-ai';

export interface WorkBuddyBuild {
  readonly id: WorkBuddyBuildId;
  readonly displayName: string;
  readonly platform: WorkBuddyBuildId;
  readonly root: string;
  readonly chatEndpoint: string;
  readonly desktopInfoFile: string;
  readonly setupHint: string;
}

const SETUP_HINT =
  '请在 WorkBuddy 客户端完成浏览器登录后返回刷新；WorkBuddy 5.6+ 可能加密桌面登录文件，此时请使用浏览器登录。';

export const WORKBUDDY_CN: WorkBuddyBuild = Object.freeze({
  id: 'workbuddy',
  displayName: 'WorkBuddy',
  platform: 'workbuddy',
  root: 'https://copilot.tencent.com',
  chatEndpoint: 'https://copilot.tencent.com/v2/chat/completions',
  desktopInfoFile: 'workbuddy-desktop.info',
  setupHint: SETUP_HINT,
});

export const WORKBUDDY_INTL: WorkBuddyBuild = Object.freeze({
  id: 'workbuddy-ai',
  displayName: 'WorkBuddy AI',
  platform: 'workbuddy-ai',
  root: 'https://www.workbuddy.ai',
  chatEndpoint: 'https://www.workbuddy.ai/v2/chat/completions',
  desktopInfoFile: 'workbuddy-desktop-ai.info',
  setupHint: SETUP_HINT,
});

export const WORKBUDDY_BUILDS: readonly WorkBuddyBuild[] = [WORKBUDDY_CN, WORKBUDDY_INTL];
