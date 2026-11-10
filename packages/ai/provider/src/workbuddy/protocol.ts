import type { WorkBuddyBuild } from './definition.ts';

export const WORKBUDDY_UA_VERSION = '5.5.6';
export const WORKBUDDY_USER_AGENT = `WorkBuddy/${WORKBUDDY_UA_VERSION}`;
export const WORKBUDDY_CONFIG_USER_AGENT = `CLI/2.0.0 WorkBuddy/${WORKBUDDY_UA_VERSION}`;

export const AUTH_POLL_INTERVAL_MS = 1_000;
export const AUTH_POLL_TIMEOUT_MS = 5 * 60_000;
export const ACCESS_TOKEN_SKEW_MS = 60_000;

export function authStateUrl(build: WorkBuddyBuild): string {
  return `${build.root}/v2/plugin/auth/state?platform=${encodeURIComponent(build.platform)}`;
}

export function authTokenUrl(build: WorkBuddyBuild, state: string): string {
  return `${build.root}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`;
}

export function loginAccountUrl(build: WorkBuddyBuild, state: string): string {
  return `${build.root}/v2/plugin/login/account?state=${encodeURIComponent(state)}`;
}

export function refreshTokenUrl(build: WorkBuddyBuild): string {
  return `${build.root}/v2/plugin/auth/token/refresh`;
}

export function configUrl(build: WorkBuddyBuild): string {
  return `${build.root}/v3/config`;
}

export function userResourceSummaryUrl(build: WorkBuddyBuild): string {
  return `${build.root}/billing/meter/get-user-resource-summary`;
}

export function enterpriseUserUsageUrl(build: WorkBuddyBuild): string {
  return `${build.root}/billing/meter/get-enterprise-user-usage`;
}

export const AUTH_STATE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'X-No-Authorization': 'true',
  'X-No-User-Id': 'true',
  'X-No-Enterprise-Id': 'true',
  'X-No-Department-Info': 'true',
});

export const LOGIN_ACCOUNT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'X-No-User-Id': 'true',
  'X-No-Enterprise-Id': 'true',
});
