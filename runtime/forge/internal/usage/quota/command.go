package quota

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// CommandDeps is the explicit dependency bundle for the quota command tree.
type CommandDeps struct {
	// LoadConfig loads the forge config.
	LoadConfig func() (ConfigInfo, []string, error)
	// DataDir is the resolved forge data directory.
	DataDir string
	// LoadBilling loads billing data.
	LoadBilling func() BillingInfo
	// ResolveBigModelToken resolves the BigModel bearer token.
	ResolveBigModelToken func() string
	// ResolveKimiToken resolves the Kimi API token.
	ResolveKimiToken func() string
	// CodexBarEnabled reports whether CodexBar snapshot is enabled.
	CodexBarEnabled func() bool
	// ProviderForOverride, when non-nil, overrides the provider factory
	// for the refresh-provider subcommand. Used by tests.
	ProviderForOverride func(name string, billing BillingInfo) Provider
	// WriteCache, when non-nil, overrides the cache writer used by the
	// refresh-provider subcommand. Used by tests to inject errors.
	WriteCache func(path string, q Quota) error
}

// ConfigInfo is a neutral view of the forge config for quota commands.
type ConfigInfo struct {
	QuotaSnapshotStaleMin   int
	QuotaStatuslineTTLSec   int
	QuotaStatuslineFetchSec int
	QuotaStatuslineRenderMs int
	QuotaUsageTTLMin        int
}

// BillingInfo carries billing data needed by quota commands.
type BillingInfo struct {
	DefaultQuotaTotal float64
}

const defaultCacheTTL = 60 * time.Second

// quotaWindowJSON extends a real provider window with remaining markers for
// consumers that render quota bars. It is a command-output shape only: cache
// and provider data continue to use Window unchanged.
type quotaWindowJSON struct {
	Name                 string     `json:"name"`
	Pct                  float64    `json:"pct"`
	ResetsAt             *time.Time `json:"resets_at,omitempty"`
	WindowMinutes        int        `json:"window_minutes,omitempty"`
	RemainingPct         float64    `json:"remaining_pct"`
	ExpectedRemainingPct *float64   `json:"expected_remaining_pct"`
}

func quotaWindowsJSON(windows []Window) []quotaWindowJSON {
	if len(windows) == 0 {
		return nil
	}
	now := timeNow()
	out := make([]quotaWindowJSON, 0, len(windows))
	for _, window := range windows {
		expectedRemaining := expectedWindowRemainingPctAt(window, now)
		if expectedRemaining != nil {
			clamped := clampPct(*expectedRemaining)
			expectedRemaining = &clamped
		}
		out = append(out, quotaWindowJSON{
			Name:                 window.Name,
			Pct:                  window.Pct,
			ResetsAt:             window.ResetsAt,
			WindowMinutes:        window.WindowMinutes,
			RemainingPct:         clampPct(100 - window.Pct),
			ExpectedRemainingPct: expectedRemaining,
		})
	}
	return out
}

// canonicalPools lists the canonical pool names in deterministic order.
var canonicalPools = []string{"codex", "codex-spark", "kimi-coding", "zhipu-coding", "anthropic", "super-grok"}

// Command dispatches the quota command. Usage: forge quota [name] [--json] [--refresh]
func Command(deps CommandDeps, args []string) int {
	// Handle refresh-provider subcommand (spawned by DefaultSpawner).
	// This bypasses normal flag/pool parsing entirely.
	if len(args) > 0 && args[0] == "refresh-provider" {
		return handleRefreshProvider(deps, args[1:])
	}

	var name string
	var asJSON bool
	var refresh bool

	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--json":
			asJSON = true
		case "--refresh":
			refresh = true
		default:
			if strings.HasPrefix(args[i], "-") {
				fmt.Fprintf(os.Stderr, "forge quota: unknown flag %s\n", args[i])
				return 2
			}
			if name == "" {
				name = args[i]
			} else {
				fmt.Fprintf(os.Stderr, "forge quota: unexpected argument %s\n", args[i])
				return 2
			}
		}
	}

	billing := deps.LoadBilling()

	if name == "" {
		return quotaListAll(deps, billing, asJSON, refresh)
	}
	return quotaShowOne(deps, name, billing, asJSON, refresh)
}

// handleRefreshProvider implements the detached child subprocess spawned by
// DefaultSpawner. It receives a canonical provider id, the cache/lock paths,
// and the lock token via env vars, performs a synchronous fetch, atomically
// persists the result, and releases the lock on every terminal path. Every
// post-fetch cache mutation (failure-marker write and successful cache write)
// runs inside RefreshLock.WithOwnedGuard so a stale worker that was suspended
// and reclaimed can never overwrite a newer attempt's cache or release a
// newer token.
func handleRefreshProvider(deps CommandDeps, args []string) int {
	if len(args) != 1 {
		fmt.Fprintf(os.Stderr, "forge quota refresh-provider: expected exactly one provider id\n")
		return 2
	}

	providerName := args[0]
	canonical, ok := canonicalPoolMap[providerName]
	if !ok {
		fmt.Fprintf(os.Stderr, "forge quota refresh-provider: unknown provider %q\n", providerName)
		return 2
	}

	if deps.DataDir == "" {
		fmt.Fprintf(os.Stderr, "forge quota refresh-provider: DataDir is empty\n")
		return 2
	}

	// Derive expected cache path using the existing pool/cache-path mapping.
	expectedCachePath := poolCachePath(deps.DataDir, canonical)

	cachePath := os.Getenv("FORGE_REFRESH_CACHE_PATH")
	lockPath := os.Getenv("FORGE_REFRESH_LOCK_PATH")
	lockToken := os.Getenv("FORGE_REFRESH_LOCK_TOKEN")

	// Require exact expected lock path and nonempty token first.
	if lockPath == "" || lockToken == "" {
		fmt.Fprintf(os.Stderr, "forge quota refresh-provider: missing FORGE_REFRESH_LOCK_PATH or FORGE_REFRESH_LOCK_TOKEN (must be spawned by DefaultSpawner)\n")
		return 2
	}

	if lockPath != expectedCachePath+".refresh.lock" {
		fmt.Fprintf(os.Stderr, "forge quota refresh-provider: FORGE_REFRESH_LOCK_PATH mismatch\n")
		return 2
	}

	// Establish guarded ownership and defer Release before validating
	// the cache path, so a missing/mismatched cache path after a valid
	// lock identity always releases the owned lock.
	rl := &RefreshLock{path: lockPath, Token: lockToken}
	if !rl.CheckOwnership() {
		fmt.Fprintf(os.Stderr, "forge quota refresh-provider: lock ownership check failed (token mismatch)\n")
		return 1
	}
	defer rl.Release()

	// Validate cache path is present and exactly expected.
	if cachePath == "" || cachePath != expectedCachePath {
		fmt.Fprintf(os.Stderr, "forge quota refresh-provider: FORGE_REFRESH_CACHE_PATH mismatch\n")
		return 1
	}

	billing := deps.LoadBilling()

	var provider Provider
	if deps.ProviderForOverride != nil {
		provider = deps.ProviderForOverride(canonical, billing)
	} else {
		provider = innerProviderFor(deps, canonical, billing)
	}
	if provider == nil {
		fmt.Fprintf(os.Stderr, "forge quota refresh-provider: unavailable provider %q\n", canonical)
		return 1
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	q, err := provider.Fetch(ctx)
	if err != nil {
		// Codex and codex-spark use fail-closed cache: replace expired
		// quota with a failure marker instead of preserving stale data.
		// The failure-marker write is atomic with ownership: the token is
		// re-verified under the guard immediately before the write, so a
		// stale worker resumed after reclaim can never overwrite a newer
		// owner's cache or marker. On ownership loss we exit without
		// writing or releasing the newer token.
		guardErr := rl.WithOwnedGuard(func() error {
			if canonical == "codex" || canonical == "codex-spark" {
				return writeRefreshFailureForce(cachePath, time.Now(), err.Error())
			}
			return writeRefreshFailure(cachePath, time.Now(), err.Error())
		})
		if errors.Is(guardErr, ErrRefreshLockOwnershipLost) {
			fmt.Fprintf(os.Stderr, "forge quota refresh-provider: lock ownership lost before failure-marker write\n")
			return 1
		}
		fmt.Fprintf(os.Stderr, "forge quota refresh-provider: %v\n", err)
		return 1
	}

	if q.FetchedAt.IsZero() {
		q.FetchedAt = time.Now()
	}

	writeFn := WriteCache
	if deps.WriteCache != nil {
		writeFn = deps.WriteCache
	}
	// The cache write is atomic with ownership: the token is re-verified
	// under the guard immediately before the write, so a stale worker can
	// never overwrite a newer owner's cache after resuming. On ownership
	// loss we exit without writing or releasing the newer token (the
	// deferred Release is token-checked and stays safe).
	guardErr := rl.WithOwnedGuard(func() error {
		return writeFn(cachePath, q)
	})
	if errors.Is(guardErr, ErrRefreshLockOwnershipLost) {
		fmt.Fprintf(os.Stderr, "forge quota refresh-provider: lock ownership lost before cache write\n")
		return 1
	}
	if guardErr != nil {
		fmt.Fprintf(os.Stderr, "forge quota refresh-provider: cache write failed: %v\n", guardErr)
		return 1
	}

	return 0
}

func quotaListAll(deps CommandDeps, billing BillingInfo, asJSON, refresh bool) int {
	type poolEntry struct {
		Pool        string            `json:"pool"`
		Label       string            `json:"label,omitempty"`
		Used        *float64          `json:"used,omitempty"`
		Total       *float64          `json:"total,omitempty"`
		Status      string            `json:"status"`
		Code        string            `json:"code,omitempty"`
		Error       string            `json:"error,omitempty"`
		Message     string            `json:"message,omitempty"`
		Windows     []quotaWindowJSON `json:"windows,omitempty"`
		Pace        *PaceJSON         `json:"pace,omitempty"`
		Reset       *ResetJSON        `json:"reset,omitempty"`
		DisplayLine string            `json:"display_line,omitempty"`
		FetchedAt   *time.Time        `json:"fetched_at,omitempty"`
		Stale       bool              `json:"stale,omitempty"`
	}

	entries := make([]poolEntry, 0, len(canonicalPools))

	for _, pool := range canonicalPools {
		entry := poolEntry{Pool: pool, Label: CanonicalLabel(pool), Status: "ok"}

		cachePath := poolCachePath(deps.DataDir, pool)

		// Resolve provider availability before accepting cache.
		provider := innerProviderFor(deps, pool, billing)
		if deps.ProviderForOverride != nil {
			provider = deps.ProviderForOverride(pool, billing)
		}

		if provider == nil {
			entry.Status = "unavailable"
			entry.Error = "unknown provider"
			if asJSON {
				entries = append(entries, entry)
			} else {
				fmt.Printf("%s: unavailable\n", pool)
			}
			continue
		}

		// Check cache first (unless --refresh)
		if !refresh {
			if cached, ok := ReadCache(cachePath); ok {
				if cacheEligibleForPool(cached, pool) {
					if cached.Used != nil {
						entry.Used = cached.Used
					}
					if cached.Total != nil {
						entry.Total = cached.Total
					}
					if len(cached.Windows) > 0 {
						entry.Windows = quotaWindowsJSON(cached.Windows)
						entry.Pace, entry.Reset = PaceAndResetJSON(cached.Windows)
					}
					if !cached.FetchedAt.IsZero() {
						entry.FetchedAt = &cached.FetchedAt
					}
					entry.Stale = cached.Stale
					cached.Label = entry.Label
					entry.DisplayLine = DisplayLine(cached)
					if asJSON {
						entries = append(entries, entry)
					} else {
						dl := entry.DisplayLine
						if dl == "" {
							fmt.Printf("%s: %.0f/%.0f\n", pool, ptrFloatVal(entry.Used), ptrFloatVal(entry.Total))
						} else {
							fmt.Println(dl)
						}
					}
					continue
				}
			}
		}

		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()

		q, err := provider.Fetch(ctx)
		if err != nil {
			// Codex and codex-spark use fail-closed cache: replace any existing
			// valid quota with a failure marker so stale data is never rendered.
			if pool == "codex" || pool == "codex-spark" {
				_ = writeRefreshFailureForce(cachePath, timeNow(), err.Error())
			}
			entry.Status = "error"
			entry.Error = err.Error()
			if asJSON {
				entries = append(entries, entry)
			} else {
				fmt.Printf("%s: error: %v\n", pool, err)
			}
			continue
		}

		// Persist the fetched data to the canonical cache.
		if q.FetchedAt.IsZero() {
			q.FetchedAt = timeNow()
		}
		writeFn := WriteCache
		if deps.WriteCache != nil {
			writeFn = deps.WriteCache
		}
		_ = writeFn(cachePath, q)

		if q.Used != nil {
			entry.Used = q.Used
		}
		if q.Total != nil {
			entry.Total = q.Total
		}
		if len(q.Windows) > 0 {
			entry.Windows = quotaWindowsJSON(q.Windows)
			entry.Pace, entry.Reset = PaceAndResetJSON(q.Windows)
		}
		if !q.FetchedAt.IsZero() {
			entry.FetchedAt = &q.FetchedAt
		}
		entry.Stale = q.Stale
		q.Label = entry.Label
		entry.DisplayLine = DisplayLine(q)

		if asJSON {
			entries = append(entries, entry)
		} else {
			dl := entry.DisplayLine
			if dl == "" {
				fmt.Printf("%s: %.0f/%.0f\n", pool, ptrFloatVal(entry.Used), ptrFloatVal(entry.Total))
			} else {
				fmt.Println(dl)
			}
		}
	}

	if asJSON {
		return printJSONQuota(entries)
	}
	return 0
}

func quotaShowOne(deps CommandDeps, name string, billing BillingInfo, asJSON, refresh bool) int {
	// Validate canonical name
	canonical := canonicalName(name)
	if canonical == "" {
		fmt.Fprintf(os.Stderr, "forge quota: unknown pool %q; available: %s\n",
			name, strings.Join(canonicalPools, ", "))
		return 2
	}

	cachePath := poolCachePath(deps.DataDir, canonical)

	// Resolve provider availability before accepting cache.
	provider := innerProviderFor(deps, canonical, billing)
	if deps.ProviderForOverride != nil {
		provider = deps.ProviderForOverride(canonical, billing)
	}
	if provider == nil {
		if asJSON {
			type singleEntry struct {
				Pool   string `json:"pool"`
				Label  string `json:"label,omitempty"`
				Status string `json:"status"`
				Error  string `json:"error"`
			}
			return printJSONQuota(singleEntry{
				Pool:   canonical,
				Label:  CanonicalLabel(canonical),
				Status: "unavailable",
				Error:  "unknown provider",
			})
		}
		fmt.Fprintf(os.Stderr, "forge quota: unavailable %q\n", canonical)
		return 1
	}

	// Check cache (unless --refresh)
	if !refresh {
		if cached, ok := ReadCache(cachePath); ok {
			if cacheEligibleForPool(cached, canonical) {
				label := CanonicalLabel(canonical)
				cached.Label = label
				dl := DisplayLine(cached)
				if asJSON {
					type singleEntry struct {
						Pool        string            `json:"pool"`
						Label       string            `json:"label,omitempty"`
						Used        float64           `json:"used"`
						Total       float64           `json:"total"`
						Windows     []quotaWindowJSON `json:"windows,omitempty"`
						Pace        *PaceJSON         `json:"pace,omitempty"`
						Reset       *ResetJSON        `json:"reset,omitempty"`
						DisplayLine string            `json:"display_line,omitempty"`
						FetchedAt   *time.Time        `json:"fetched_at,omitempty"`
						Stale       bool              `json:"stale,omitempty"`
						Status      string            `json:"status"`
						Source      string            `json:"source,omitempty"`
						From        string            `json:"from,omitempty"`
					}
					pace, reset := PaceAndResetJSON(cached.Windows)
					entry := singleEntry{
						Pool:        canonical,
						Label:       label,
						Used:        ptrFloatVal(cached.Used),
						Total:       ptrFloatVal(cached.Total),
						Windows:     quotaWindowsJSON(cached.Windows),
						Pace:        pace,
						Reset:       reset,
						DisplayLine: dl,
						FetchedAt:   timePtr(cached.FetchedAt),
						Stale:       cached.Stale,
						Status:      "ok",
						Source:      "cache",
						From:        "cache",
					}
					return printJSONQuota(entry)
				}
				if dl != "" {
					fmt.Println(dl)
				} else {
					fmt.Printf("%s: %.0f/%.0f\n", canonical, ptrFloatVal(cached.Used), ptrFloatVal(cached.Total))
				}
				return 0
			}
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	q, err := provider.Fetch(ctx)
	if err != nil {
		// Codex and codex-spark use fail-closed cache: replace any existing
		// valid quota with a failure marker so stale data is never rendered.
		if canonical == "codex" || canonical == "codex-spark" {
			_ = writeRefreshFailureForce(cachePath, timeNow(), err.Error())
		}
		if asJSON {
			type singleEntry struct {
				Pool   string `json:"pool"`
				Label  string `json:"label,omitempty"`
				Status string `json:"status"`
				Error  string `json:"error"`
			}
			return printJSONQuota(singleEntry{
				Pool:   canonical,
				Label:  CanonicalLabel(canonical),
				Status: "error",
				Error:  err.Error(),
			})
		}
		fmt.Fprintf(os.Stderr, "forge quota: %v\n", err)
		return 1
	}

	// Persist the fetched data to the canonical cache.
	if q.FetchedAt.IsZero() {
		q.FetchedAt = timeNow()
	}
	writeFn := WriteCache
	if deps.WriteCache != nil {
		writeFn = deps.WriteCache
	}
	_ = writeFn(cachePath, q)

	label := CanonicalLabel(canonical)
	q.Label = label
	dl := DisplayLine(q)

	if asJSON {
		type singleEntry struct {
			Pool        string            `json:"pool"`
			Label       string            `json:"label,omitempty"`
			Used        float64           `json:"used"`
			Total       float64           `json:"total"`
			Windows     []quotaWindowJSON `json:"windows,omitempty"`
			DisplayLine string            `json:"display_line,omitempty"`
			Pace        *PaceJSON         `json:"pace,omitempty"`
			Reset       *ResetJSON        `json:"reset,omitempty"`
			FetchedAt   *time.Time        `json:"fetched_at,omitempty"`
			Stale       bool              `json:"stale,omitempty"`
			Status      string            `json:"status"`
			Error       string            `json:"error,omitempty"`
			Message     string            `json:"message,omitempty"`
		}
		pace, reset := PaceAndResetJSON(q.Windows)
		entry := singleEntry{
			Pool:        canonical,
			Label:       label,
			Used:        ptrFloatVal(q.Used),
			Total:       ptrFloatVal(q.Total),
			Windows:     quotaWindowsJSON(q.Windows),
			DisplayLine: dl,
			Pace:        pace,
			Reset:       reset,
			FetchedAt:   timePtr(q.FetchedAt),
			Stale:       q.Stale,
			Status:      "ok",
			Message:     q.Message,
		}
		return printJSONQuota(entry)
	}
	if dl != "" {
		fmt.Println(dl)
	} else {
		fmt.Printf("%s: %.0f/%.0f\n", canonical, ptrFloatVal(q.Used), ptrFloatVal(q.Total))
	}
	return 0
}

func timePtr(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	return &t
}

func canonicalName(name string) string {
	canon, ok := canonicalPoolMap[strings.ToLower(strings.TrimSpace(name))]
	if !ok {
		return ""
	}
	return canon
}

// poolCachePath returns the canonical cache file path for a given pool name
// under the specified data directory.
func poolCachePath(dataDir, pool string) string {
	return filepath.Join(dataDir, "quota", pool+".json")
}

// cacheEligibleForPool checks whether the given cached Quota is eligible
// for direct command display. The cache is usable when:
//   - FetchedAt is non-zero and age is non-negative and below defaultCacheTTL
//   - For codex/codex-spark, the source must be exactly "codex-app-server"
func cacheEligibleForPool(cached Quota, pool string) bool {
	if cached.FetchedAt.IsZero() {
		return false
	}
	age := timeNow().Sub(cached.FetchedAt)
	if age < 0 || age >= defaultCacheTTL {
		return false
	}
	if (pool == "codex" || pool == "codex-spark") && cached.Source != "codex-app-server" {
		return false
	}
	return true
}

var canonicalPoolMap = map[string]string{
	"codex":        "codex",
	"codex-spark":  "codex-spark",
	"spark":        "codex-spark",
	"kimi-coding":  "kimi-coding",
	"kimi":         "kimi-coding",
	"zhipu-coding": "zhipu-coding",
	"glm":          "zhipu-coding",
	"zai":          "zhipu-coding",
	"anthropic":    "anthropic",
	"super-grok":   "super-grok",
}

func ptrFloatVal(f *float64) float64 {
	if f == nil {
		return 0
	}
	return *f
}

func printJSONQuota(value interface{}) int {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	fmt.Println(string(data))
	return 0
}

func innerProviderFor(deps CommandDeps, name string, billing BillingInfo) Provider {
	switch name {
	case "zhipu-coding":
		token := deps.ResolveBigModelToken()
		return BigModelProvider{Token: token}
	case "kimi-coding":
		return KimiProvider{Token: deps.ResolveKimiToken()}
	case "anthropic":
		cfg, _, _ := deps.LoadConfig()
		staleDur := time.Duration(cfg.QuotaSnapshotStaleMin) * time.Minute
		return ClaudeProvider{
			ProviderName:          name,
			AllowCLI:              false,
			AllowKeychain:         true,
			AllowSnapshot:         deps.CodexBarEnabled(),
			SnapshotStaleDuration: staleDur,
		}
	case "codex", "codex-spark":
		return CodexProvider{
			ProviderName: name,
		}
	default:
		return nil
	}
}

// SameLocalCalendarDay returns true if a and b fall on the same local day.
func SameLocalCalendarDay(a, b time.Time) bool {
	if a.IsZero() || b.IsZero() {
		return false
	}
	a = a.In(time.Local)
	b = b.In(time.Local)
	ay, am, ad := a.Date()
	by, bm, bd := b.Date()
	return ay == by && am == bm && ad == bd
}

// paceAndResetFromWindows computes optional pace and reset strings from the
// authoritative (last) window. Returns empty strings when no windows exist.
func paceAndResetFromWindows(windows []Window) (string, string) {
	paceJSON, resetJSON := PaceAndResetJSON(windows)
	pace := ""
	if paceJSON != nil {
		pace = paceJSON.Text
	}
	reset := ""
	if resetJSON != nil {
		reset = resetJSON.In
	}
	return pace, reset
}

func hasFlag(args []string, flag string) bool {
	for _, arg := range args {
		if arg == flag || strings.HasPrefix(arg, flag+"=") {
			return true
		}
	}
	return false
}
