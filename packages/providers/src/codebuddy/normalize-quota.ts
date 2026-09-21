import { object, observation, time } from '../base/quota-parsing.ts';
import type { QuotaSnapshot } from '../base/quota-snapshot.ts';
/** Runtime validates the active account scope before exposing this observation. */
export function normalizeCodeBuddyQuota(raw: unknown, now = Date.now()): QuotaSnapshot | undefined {
    const row = object(observation(raw).data), reset = time(row.resets_at);
    if (row.exhausted !== true || row.reason_code !== 'quota_exhausted' || !reset || Date.parse(reset) <= now)
        return undefined;
    return { provider: 'codebuddy', status: 'ok', stale: false, source: 'observed', windows: [{ name: 'observed', pct: 100, window_minutes: 0, resets_at: reset }], message: 'CodeBuddy 额度已耗尽，重置后将自动恢复。' };
}
