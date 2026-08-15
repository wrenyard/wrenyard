package quota

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

type CachedProvider struct {
	Inner      Provider
	Path       string
	TTL        time.Duration
	RefreshAge time.Duration // stale-while-revalidate threshold (0 = no SWR, fall back to TTL)

	// CooldownTTL caps the failureTTL backoff when set (0 = default 60s).
	// For providers where a transient failure may be persistent, set this
	// to a longer duration to avoid respawning doomed refresh subprocesses.
	CooldownTTL time.Duration

	// Spawner spawns detached refresh subprocesses. Nil means use
	// DefaultSpawner (real forge binary). Inject NoopSpawner for tests.
	Spawner Spawner

	// SWROnly disables synchronous Inner.Fetch entirely: returns cached data
	// immediately (or empty if absent) and kicks the detached refresh
	// subprocess when the cache is stale. Only the detached subprocess
	// performs real fetches. For use on rendering paths that must never block
	// on network/browser calls (e.g. statusline).
	SWROnly bool

	// FailClosed enables hard-TTL semantics: a cache entry is usable only
	// while it is younger than TTL. Once TTL expires, a synchronous refresh
	// is attempted. If the refresh fails, the error is returned — expired
	// quota is never returned and stale is never set. In SWROnly mode,
	// FailClosed prevents returning expired cached data: at/over TTL the
	// provider returns an expiration error (no stale, no old Quota) and
	// a background refresh is kicked. If no cache exists, an unavailable
	// error is returned instead of an empty success.
	FailClosed bool

	// RequiredSource, when non-empty, rejects cached entries whose
	// Quota.Source does not exactly match this value. Under normal
	// (non-SWROnly) mode a source mismatch bypasses the cache and
	// synchronously fetches from Inner. Under SWROnly + FailClosed
	// it kicks a background refresh and returns a meaningful error.
	// Under SWROnly (no FailClosed) it kicks a spawn and returns
	// empty Quota. When RequiredSource is empty, all cache entries
	// are accepted — preserving legacy behavior.
	RequiredSource string
}

type cacheEntry struct {
	Quota     Quota     `json:"quota"`
	FetchedAt time.Time `json:"fetched_at"`
	FailedAt  time.Time `json:"failed_at,omitempty"`
	Error     string    `json:"error,omitempty"`

	// CooldownUntil, when set and in the future, prevents SWR background
	// refresh spawns for this cache entry. Set by the detached refresh
	// subprocess when a refresh fails permanently.
	CooldownUntil time.Time `json:"cooldown_until,omitempty"`

	// LastAttemptAt records the most recent time a background refresh
	// was attempted (spawned). Used to throttle repeat spawns for
	// non-cookie failures where FetchedAt never advances: we only try
	// again after RefreshAge has elapsed since the last attempt.
	// This is independent of CooldownUntil — it bounds spawn rate
	// without marking the cache Unavailable.
	LastAttemptAt time.Time `json:"last_attempt_at,omitempty"`
}

func (p *CachedProvider) Name() string { return p.Inner.Name() }

func (p *CachedProvider) Fetch(ctx context.Context) (Quota, error) {
	now := time.Now()

	// Determine SWR refresh age.
	refreshAge := p.RefreshAge
	if refreshAge <= 0 {
		refreshAge = p.TTL // no per-provider threshold — use full TTL (backward compat)
	}

	// --- SWR-only mode ---
	// Never call Inner.Fetch synchronously. Returns cached data immediately
	// (or empty if absent) and kicks the detached refresh subprocess when
	// stale. Cooldown is TTL-independent: an active cooldown suppresses both
	// synchronous fetches AND background spawns regardless of cache age.
	if p.SWROnly {
		cached, hasCache := readCache(p.Path)

		if p.FailClosed {
			// FailClosed + SWROnly: hard-TTL semantics. Never return stale
			// quota or empty success.

			if !hasCache {
				// No cache — kick refresh and return an error.
				p.kickBackgroundRefresh(ctx)
				return Quota{}, fmt.Errorf("%s quota unavailable: refresh started", p.Inner.Name())
			}

			// FailClosed + active cooldown: return a meaningful error and no Quota.
			// Never return stale/unavailable cached data.
			if !cached.CooldownUntil.IsZero() && now.Before(cached.CooldownUntil) {
				return Quota{}, fmt.Errorf("%s quota unavailable: cooldown active until %s", p.Inner.Name(), cached.CooldownUntil.Format(time.RFC3339))
			}

			// Compute the same bounded failure TTL used by normal mode.
			failureTTL := p.TTL
			if p.CooldownTTL > 0 && failureTTL > p.CooldownTTL {
				failureTTL = p.CooldownTTL
			} else if failureTTL > 60*time.Second {
				failureTTL = 60 * time.Second
			}

			// Failure marker: valid only within a bounded time window.
			// Expired or future-dated markers must not block recovery.
			if !cached.FailedAt.IsZero() {
				age := now.Sub(cached.FailedAt)
				if age >= 0 && age < failureTTL {
					return Quota{}, errors.New(cached.Error)
				}
				// Expired or future-dated: kick refresh (bypass throttle) and return
				// a meaningful error.
				p.kickBackgroundRefreshNoThrottle(ctx)
				return Quota{}, fmt.Errorf("%s quota unavailable: refresh started", p.Inner.Name())
			}

			// Check TTL.
			age := now.Sub(cached.FetchedAt)
			if age >= 0 && age < p.TTL {
				// Source guard: reject cache from a different source.
				if p.RequiredSource != "" && cached.Quota.Source != p.RequiredSource {
					p.kickBackgroundRefresh(ctx)
					return Quota{}, fmt.Errorf("%s quota source mismatch: got %q, want %q", p.Inner.Name(), cached.Quota.Source, p.RequiredSource)
				}
				// Valid and fresh — return normally.
				q := cached.Quota
				q.FetchedAt = cached.FetchedAt
				q.CacheAge = age
				return q, nil
			}

			// At/over TTL with FailClosed: kick refresh and return error.
			// Never return old Quota, never set Stale.
			p.kickBackgroundRefresh(ctx)
			return Quota{}, fmt.Errorf("%s quota expired", p.Inner.Name())
		}

		if hasCache {
			// Source guard: reject cache from a different source.
			// Treat as no usable cache — kick spawn and return empty.
			if p.RequiredSource != "" && cached.Quota.Source != p.RequiredSource {
				p.kickBackgroundRefresh(ctx)
				return Quota{}, nil
			}
			age := now.Sub(cached.FetchedAt)
			if !cached.CooldownUntil.IsZero() && now.Before(cached.CooldownUntil) {
				q := cached.Quota
				q.FetchedAt = cached.FetchedAt
				q.CacheAge = age
				q.Stale = true
				q.Unavailable = true
				return q, nil
			}

			// Cooldown expired or not set — kick spawn if stale, return cached.
			if age >= refreshAge {
				p.kickBackgroundRefresh(ctx)
			}
			q := cached.Quota
			q.FetchedAt = cached.FetchedAt
			q.CacheAge = age
			if age >= p.TTL {
				q.Stale = true
			}
			return q, nil
		}

		// No cache — kick spawn and return empty quota.
		p.kickBackgroundRefresh(ctx)
		return Quota{}, nil
	}

	// --- Normal mode ---

	// Check for failure marker (negative cache) — prevent refetch storms.
	failureTTL := p.TTL
	if p.CooldownTTL > 0 && failureTTL > p.CooldownTTL {
		failureTTL = p.CooldownTTL
	} else if failureTTL > 60*time.Second {
		failureTTL = 60 * time.Second
	}
	if entry, ok := readCache(p.Path); ok && !entry.FailedAt.IsZero() {
		entryAge := now.Sub(entry.FailedAt)
		if entryAge >= 0 && entryAge < failureTTL {
			return Quota{}, errors.New(entry.Error)
		}
	}

	// Check for valid cached quota.
	if cached, ok := readCache(p.Path); ok {
		// Source guard: reject cache from a different source.
		// Bypass cache entirely and fall through to synchronous fetch.
		if p.RequiredSource == "" || cached.Quota.Source == p.RequiredSource {
			age := now.Sub(cached.FetchedAt)
			if age >= 0 && age < p.TTL {
				// STALE-WHILE-REVALIDATE: if cache is older than refresh age
				// but still within hard TTL, return cached immediately and
				// kick a single-flight async background refresh — unless
				// the entry is in a cooldown period (a previous refresh
				// determined a retry would be doomed).
				if age >= refreshAge {
					if cached.CooldownUntil.IsZero() || now.After(cached.CooldownUntil) {
						p.kickBackgroundRefresh(ctx)
					}
				}
				q := cached.Quota
				q.FetchedAt = cached.FetchedAt
				q.CacheAge = age
				return q, nil
			}

			// Fail-closed: TTL has expired. Trigger synchronous refresh and
			// never return expired data. Do NOT fall back to stale.
			if p.FailClosed {
				q, err := p.Inner.Fetch(ctx)
				if err == nil {
					if q.FetchedAt.IsZero() {
						q.FetchedAt = now
					}
					_ = writeCache(p.Path, q)
					q.CacheAge = time.Since(q.FetchedAt)
					return q, nil
				}
				// Refresh failed — write a failure marker and return the error.
				_ = writeFailureMarker(p.Path, now, err.Error())
				return Quota{}, err
			}
		}
	}

	q, err := p.Inner.Fetch(ctx)
	if err == nil {
		if q.FetchedAt.IsZero() {
			q.FetchedAt = now
		}
		_ = writeCache(p.Path, q)
		q.CacheAge = time.Since(q.FetchedAt)
		return q, nil
	}

	// On failure, check for stale entry to fall back to (unless fail-closed).
	if !p.FailClosed {
		if cached, ok := readCache(p.Path); ok && cached.FailedAt.IsZero() {
			q := cached.Quota
			q.FetchedAt = cached.FetchedAt
			q.CacheAge = now.Sub(cached.FetchedAt)
			q.Stale = true
			if q.Message == "" {
				q.Message = "stale: " + err.Error()
			}
			return q, nil
		}
	}

	// No stale entry — write a failure marker to cap retry frequency.
	_ = writeFailureMarker(p.Path, now, err.Error())

	return Quota{}, err
}

// kickBackgroundRefresh spawns a detached subprocess (forge quota
// refresh-provider) to refresh the cache. Single-flight is enforced
// cross-process via a lockfile at <cachePath>.refresh.lock.
//
// The lockfile is created with a unique token. The spawner (real or
// injected) must release the lockfile when the refresh completes. While
// the lockfile exists, any other refresh attempt will find it and skip.
//
// Locking scope for cache writes:
//   - UNDER the refresh lock: this function's LastAttemptAt stamp and
//     the detached child's writes (writeCache, SetCacheCooldown,
//     SetCacheLastAttemptAt). These are all SWR background-refresh
//     writers, serialized by the lock token to prevent lost updates.
//   - OUTSIDE the refresh lock (by design): foreground writers such as
//     forge usage (CachedProvider.Fetch with SWROnly=false → writeCache,
//     writeFailureMarker). These are user-initiated refresh operations
//     where superseding cached data or cooldown is the correct semantics.
//     They are pre-existing and intentionally not wrapped in the refresh
//     lock to avoid lock contention regressions in user-facing commands.
//
// The throttle (LastAttemptAt) is checked BEFORE acquiring the lock to
// avoid contention. The stamp is written only AFTER the lock is held,
// ensuring all cache mutations are serialized by the refresh lock (the
// detached child holds the same lock token). The throttle window is
// p.RefreshAge — at most one spawn per refresh cycle, independent of
// cooldown state.
//
// On spawn failure the function returns silently — the stale cache is
// still valid for display.
func (p *CachedProvider) kickBackgroundRefresh(ctx context.Context) {
	now := time.Now()
	refreshAge := p.RefreshAge
	if refreshAge <= 0 {
		refreshAge = p.TTL
	}

	// Throttle check: read the cache file directly (not via readCache,
	// which rejects entries without FetchedAt/FailedAt) so a
	// LastAttemptAt-only stamp from a previous no-cache-throttle write
	// is recognized.
	if stamp := readCacheLastAttemptAt(p.Path); !stamp.IsZero() && now.Sub(stamp) < refreshAge {
		return // throttled — wait for the next refresh window
	}

	p.kickBackgroundRefreshLocked(ctx, now)
}

// kickBackgroundRefreshLocked acquires the cross-process refresh lock,
// stamps LastAttemptAt, spawns the detached refresh, and releases the
// lock on spawn failure. Used by kickBackgroundRefresh (with throttle)
// and kickBackgroundRefreshNoThrottle (without throttle).
func (p *CachedProvider) kickBackgroundRefreshLocked(ctx context.Context, now time.Time) {
	// Acquire the refresh lock BEFORE stamping. Only one process (parent
	// or child) holds the lock token at a time, so all cache writes are
	// serialized. If the lock isn't available, a child is running — let
	// it handle the refresh; return without stamping.
	lockPath := p.Path + ".refresh.lock"
	lock, err := AcquireRefreshLock(lockPath)
	if err != nil {
		return // lock held by another refresh — skip (child in flight)
	}

	// Annotate last attempt BEFORE spawning the child so the throttle
	// bounds spawn frequency. Written under the lock so it cannot race
	// with the child's writes (success Quota, Cooldown, failure stamp).
	_ = SetCacheLastAttemptAt(p.Path, now, true)

	spawner := p.Spawner
	if spawner == nil {
		spawner = DefaultSpawner{}
	}
	if err := spawner.Spawn(p.Inner.Name(), p.Path, lock.Token); err != nil {
		// Spawn failed — release the lock immediately so refreshes are
		// not suppressed for the full stale timeout (2 min).
		lock.Release()
	}
}

// kickBackgroundRefreshNoThrottle is like kickBackgroundRefresh but
// bypasses the LastAttemptAt throttle check. Used by FailClosed+SWROnly
// when an expired or future-dated failure marker must be recovered
// without waiting for the throttle window to elapse.
func (p *CachedProvider) kickBackgroundRefreshNoThrottle(ctx context.Context) {
	p.kickBackgroundRefreshLocked(ctx, time.Now())
}

func ReadCache(path string) (Quota, bool) {
	entry, ok := readCache(path)
	if !ok {
		return Quota{}, false
	}
	// Reject pure failure markers (FailedAt set but no valid cached data).
	// The dispatch segment reads cache directly; failure markers have
	// zero-valued Quota which renders as empty — avoid that.
	if !entry.FailedAt.IsZero() && entry.FetchedAt.IsZero() {
		return Quota{}, false
	}
	q := entry.Quota
	q.FetchedAt = entry.FetchedAt
	q.CacheAge = time.Since(entry.FetchedAt)
	// Surface cooldown state to rendering code: when an active cooldown
	// is suppressing background refresh, the provider is genuinely
	// unavailable (e.g. SSO/cookie dead), not just stale.
	if !entry.CooldownUntil.IsZero() && time.Now().Before(entry.CooldownUntil) {
		q.Unavailable = true
	}
	return q, true
}

func readCache(path string) (cacheEntry, bool) {
	if path == "" {
		return cacheEntry{}, false
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return cacheEntry{}, false
	}
	var entry cacheEntry
	if err := json.Unmarshal(raw, &entry); err != nil {
		return cacheEntry{}, false
	}
	if entry.FailedAt.IsZero() && entry.FetchedAt.IsZero() {
		entry.FetchedAt = entry.Quota.FetchedAt
	}
	if entry.FailedAt.IsZero() && entry.FetchedAt.IsZero() {
		return cacheEntry{}, false
	}
	return entry, true
}

// WriteCache writes a Quota to the cache file atomically.
func WriteCache(path string, q Quota) error { return writeCache(path, q) }

func writeCache(path string, q Quota) error {
	if path == "" {
		return errors.New("empty cache path")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	entry := cacheEntry{Quota: q, FetchedAt: q.FetchedAt}
	raw, err := json.MarshalIndent(entry, "", "  ")
	if err != nil {
		return err
	}
	return safeAtomicWrite(path, raw, 0o600)
}

// writeRefreshFailure writes a failure marker that preserves an existing
// valid quota entry (including FetchedAt and LastAttemptAt) unchanged on
// a detached refresh failure. When no valid quota exists, it atomically
// writes a quota-free failure marker that preserves any existing
// LastAttemptAt throttle stamp.
//
// force, when true, replaces an existing valid quota entry with a failure
// marker instead of preserving it. Used by fail-closed providers where
// expired quota must not be preserved on refresh failure.
func writeRefreshFailure(path string, now time.Time, errMsg string) error {
	return writeRefreshFailureChecked(path, now, errMsg, false)
}

// writeRefreshFailureForce is like writeRefreshFailure but always replaces
// an existing valid quota entry with a failure marker. Used by fail-closed
// providers (e.g. Codex) where expired quota must not be preserved.
func writeRefreshFailureForce(path string, now time.Time, errMsg string) error {
	return writeRefreshFailureChecked(path, now, errMsg, true)
}

func writeRefreshFailureChecked(path string, now time.Time, errMsg string, force bool) error {
	if path == "" {
		return errors.New("empty cache path")
	}

	entry, ok := readCache(path)
	if ok && !entry.FetchedAt.IsZero() {
		if !force {
			// Valid quota exists — preserve it unchanged. The stale entry
			// remains valid for rendering; a failed detached refresh must
			// not destroy renderable data. LastAttemptAt is preserved too.
			return nil
		}
		// force == true: replace existing quota with a failure marker,
		// preserving LastAttemptAt throttle stamp.
		lastAttemptAt := entry.LastAttemptAt
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return err
		}
		entry = cacheEntry{
			FailedAt:      now,
			Error:         errMsg,
			LastAttemptAt: lastAttemptAt,
		}
		raw, err := json.MarshalIndent(entry, "", "  ")
		if err != nil {
			return err
		}
		return safeAtomicWrite(path, raw, 0o600)
	}

	// No valid quota. Preserve any existing LastAttemptAt throttle stamp
	// so spawn-rate bounding survives across detached refreshes.
	lastAttemptAt := entry.LastAttemptAt
	if !ok {
		lastAttemptAt = readCacheLastAttemptAt(path)
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	entry = cacheEntry{
		FailedAt:      now,
		Error:         errMsg,
		LastAttemptAt: lastAttemptAt,
	}
	raw, err := json.MarshalIndent(entry, "", "  ")
	if err != nil {
		return err
	}
	return safeAtomicWrite(path, raw, 0o600)
}

func writeFailureMarker(path string, now time.Time, errMsg string) error {
	if path == "" {
		return errors.New("empty cache path")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	entry := cacheEntry{FailedAt: now, Error: errMsg}
	raw, err := json.MarshalIndent(entry, "", "  ")
	if err != nil {
		return err
	}
	return safeAtomicWrite(path, raw, 0o600)
}

// SetCacheCooldown writes a cooldown onto the cache entry at path, preserving
// any existing quota data and FetchedAt. After the cooldown expires, normal
// SWR will resume. Used by the detached refresh subprocess when a refresh
// fails permanently.
func SetCacheCooldown(path string, duration time.Duration) error {
	entry, ok := readCache(path)
	if !ok {
		// No existing cache to annotate — nothing to do.
		return nil
	}
	entry.CooldownUntil = time.Now().Add(duration)
	raw, err := json.MarshalIndent(entry, "", "  ")
	if err != nil {
		return err
	}
	return safeAtomicWrite(path, raw, 0o600)
}

// readCacheLastAttemptAt reads LastAttemptAt from the cache file. Unlike
// readCache / ReadCache, it does NOT require FetchedAt or FailedAt —
// it accepts a LastAttemptAt-only entry (created when no cache yet
// exists and kickBackgroundRefresh stamps the throttle under the lock).
func readCacheLastAttemptAt(path string) time.Time {
	if path == "" {
		return time.Time{}
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return time.Time{}
	}
	var entry cacheEntry
	if json.Unmarshal(raw, &entry) != nil {
		return time.Time{}
	}
	return entry.LastAttemptAt
}

// SetCacheLastAttemptAt writes a last-attempt timestamp onto the cache
// entry, preserving any existing quota data, FetchedAt, and cooldown.
// Used by kickBackgroundRefresh to throttle repeat spawns when a refresh
// keeps failing without advancing FetchedAt (e.g. transient non-cookie
// errors). This is independent of CooldownUntil — it bounds spawn rate
// without marking the cache Unavailable.
//
// When allowCreate is true and no cache entry exists, a minimal
// LastAttemptAt-only entry is written to disk. This entry does NOT
// render as quota data (readCache rejects entries without FetchedAt
// or FailedAt), but the throttle in kickBackgroundRefresh recognizes
// it via readCacheLastAttemptAt and bounds spawn rate. When the
// first successful fetch writes a full cache entry, the minimal
// entry is overwritten.
func SetCacheLastAttemptAt(path string, t time.Time, allowCreate bool) error {
	entry, ok := readCache(path)
	if !ok {
		if !allowCreate {
			return nil
		}
		// No cache exists — create a minimal entry for throttle only.
		entry = cacheEntry{LastAttemptAt: t}
		raw, err := json.MarshalIndent(entry, "", "  ")
		if err != nil {
			return err
		}
		return safeAtomicWrite(path, raw, 0o600)
	}
	entry.LastAttemptAt = t
	raw, err := json.MarshalIndent(entry, "", "  ")
	if err != nil {
		return err
	}
	return safeAtomicWrite(path, raw, 0o600)
}
