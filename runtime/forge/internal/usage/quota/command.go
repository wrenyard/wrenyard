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

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/observedquota"
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
	// ResolveDeepSeekToken resolves the DeepSeek quota bearer token from
	// the user-owned DEEPSEEK_API_KEY / FORGE_DEEPSEEK_API_KEY. DeepSeek is
	// quota-only and never reads auth.json.
	ResolveDeepSeekToken func() string
	// CodexBarEnabled reports whether CodexBar snapshot is enabled.
	CodexBarEnabled func() bool
	// ProviderForOverride, when non-nil, overrides the provider factory
	// for the refresh-provider subcommand. Used by tests.
	ProviderForOverride func(name string, billing BillingInfo) Provider
	// WriteCache, when non-nil, overrides the cache writer used by the
	// refresh-provider subcommand. Used by tests to inject errors.
	WriteCache func(path string, q Quota) error
	// ObservedQuotaRoot overrides the observed provider quota store root.
	// Empty uses the shared XDG-aware default state root; tests set it to
	// isolate the observed CodeBuddy projection.
	ObservedQuotaRoot string
	// ResolveSuperGrokAuthSources returns readable native Grok auth.json paths
	// in precedence order. Nil/empty means the local login is not configured.
	ResolveSuperGrokAuthSources func() []string
	// CodeBuddyExpectedScope is the expected opaque CodeBuddy execution/quota
	// scope bound by the calling Foreman context. CodeBuddy is projected only
	// when this and CodeBuddyExpectedEnvironment are both non-empty and the
	// current resolver returns the exact same scope and environment.
	CodeBuddyExpectedScope string
	// CodeBuddyExpectedEnvironment is the expected normalized CodeBuddy
	// environment bound by the calling Foreman context.
	CodeBuddyExpectedEnvironment string
	// CodeBuddyActiveScope independently resolves the current CodeBuddy login's
	// opaque scope and normalized environment. ok=false (or empty values) means
	// no current login can be resolved and CodeBuddy must be omitted. This
	// package never imports the auth package; the resolver is provided by the
	// caller.
	CodeBuddyActiveScope func() (scope, environment string, ok bool)
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

// canonicalProviders lists the canonical provider names in deterministic order.
var canonicalProviders = []string{"chatgpt", "cursor", "deepseek", "zhipu-coding", "kimi-coding", "anthropic", "super-grok"}

// Command dispatches the quota command. Usage: forge quota [name] [--json] [--refresh]
func Command(deps CommandDeps, args []string) int {
	// Handle refresh-provider subcommand (spawned by DefaultSpawner).
	// This bypasses normal flag/provider parsing entirely.
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
	canonical, ok := canonicalProviderMap[providerName]
	if !ok {
		fmt.Fprintf(os.Stderr, "forge quota refresh-provider: unknown provider %q\n", providerName)
		return 2
	}

	if deps.DataDir == "" {
		fmt.Fprintf(os.Stderr, "forge quota refresh-provider: DataDir is empty\n")
		return 2
	}

	// Derive expected cache path using the existing provider/cache-path mapping.
	expectedCachePath := providerCachePath(deps.DataDir, canonical)

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
	// Codex/ChatGPT, cursor, and deepseek use fail-closed cache: replace
	// expired quota with a failure marker instead of preserving stale
	// data. The failure-marker write is atomic with ownership: the token
		// is re-verified under the guard immediately before the write, so a
		// stale worker resumed after reclaim can never overwrite a newer
		// owner's cache or marker. On ownership loss we exit without
		// writing or releasing the newer token.
		guardErr := rl.WithOwnedGuard(func() error {
			if failClosedProvider(canonical) {
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

// providerEntry is the canonical quota list row shared by the regular
// providers and the observed CodeBuddy projection.
type providerEntry struct {
	Provider string            `json:"provider"`
	Label    string            `json:"label,omitempty"`
	Used     *float64          `json:"used,omitempty"`
	Total    *float64          `json:"total,omitempty"`
	Balances []MoneyBalance    `json:"balances,omitempty"`
	Status   string            `json:"status"`
	Code     string            `json:"code,omitempty"`
	Error    string            `json:"error,omitempty"`
	Message  string            `json:"message,omitempty"`
	Windows  []quotaWindowJSON `json:"windows,omitempty"`
	// NotApplicableWindows propagates the provider-confirmed absent windows
	// (e.g. Pro plan without a 5h primary) into the command JSON projection.
	NotApplicableWindows []string   `json:"not_applicable_windows,omitempty"`
	Pace                 *PaceJSON  `json:"pace,omitempty"`
	Reset                *ResetJSON `json:"reset,omitempty"`
	DisplayLine          string     `json:"display_line,omitempty"`
	FetchedAt            *time.Time `json:"fetched_at,omitempty"`
	Stale                bool       `json:"stale,omitempty"`
}

func quotaListAll(deps CommandDeps, billing BillingInfo, asJSON, refresh bool) int {
	entries := make([]providerEntry, 0, len(canonicalProviders))

	for _, providerName := range canonicalProviders {
		entry := providerEntry{Provider: providerName, Label: CanonicalLabel(providerName), Status: "ok"}

		cachePath := providerCachePath(deps.DataDir, providerName)

		// Resolve provider availability before accepting cache.
		provider := innerProviderFor(deps, providerName, billing)
		if deps.ProviderForOverride != nil {
			provider = deps.ProviderForOverride(providerName, billing)
		}

		if provider == nil {
			entry.Status = "unavailable"
			entry.Error = "unknown provider"
			if asJSON {
				entries = append(entries, entry)
			} else {
				fmt.Printf("%s: unavailable\n", providerName)
			}
			continue
		}

		// Check cache first (unless --refresh)
		if !refresh {
			if cached, ok := ReadCache(cachePath); ok {
				if cacheEligibleForProvider(cached, providerName) {
					if cached.Used != nil {
						entry.Used = cached.Used
					}
					if cached.Total != nil {
						entry.Total = cached.Total
					}
					if len(cached.Balances) > 0 {
						entry.Balances = cached.Balances
					}
					if len(cached.Windows) > 0 {
						entry.Windows = quotaWindowsJSON(cached.Windows)
						entry.Pace, entry.Reset = PaceAndResetJSON(cached.Windows)
					}
					entry.NotApplicableWindows = cached.NotApplicableWindows
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
							fmt.Printf("%s: %.0f/%.0f\n", providerName, ptrFloatVal(entry.Used), ptrFloatVal(entry.Total))
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
			// Fail-closed providers replace any existing valid quota with a
			// failure marker so stale data is never rendered.
			if failClosedProvider(providerName) {
				_ = writeRefreshFailureForce(cachePath, timeNow(), err.Error())
			}
			projectQuotaFetchError(&entry, err)
			if asJSON {
				entries = append(entries, entry)
			} else {
				fmt.Printf("%s: error: %v\n", providerName, err)
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
		if len(q.Balances) > 0 {
			entry.Balances = q.Balances
		}
		if len(q.Windows) > 0 {
			entry.Windows = quotaWindowsJSON(q.Windows)
			entry.Pace, entry.Reset = PaceAndResetJSON(q.Windows)
		}
		entry.NotApplicableWindows = q.NotApplicableWindows
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
				fmt.Printf("%s: %.0f/%.0f\n", providerName, ptrFloatVal(entry.Used), ptrFloatVal(entry.Total))
			} else {
				fmt.Println(dl)
			}
		}
	}

	// Project the locally observed CodeBuddy exhaustion from the privacy-safe
	// store. This is the only CodeBuddy quota surface: no CodeBuddy endpoint is
	// ever fetched and no provider quota binding is declared. When the state is
	// absent or expired, codebuddy is omitted so Desktop keeps its
	// connected-but-no-quota behavior.
	if entry, ok := observedCodeBuddyEntry(deps); ok {
		entries = append(entries, entry)
		if !asJSON {
			if dl := entry.DisplayLine; dl != "" {
				fmt.Println(dl)
			}
		}
	}

	if asJSON {
		return printJSONQuota(entries)
	}
	return 0
}

// observedCodeBuddyEntry projects the canonical CodeBuddy provider from the
// locally observed, current-scoped schema-v2 exhaustion record. It appears
// only when the bound expected scope+environment are non-empty, the caller's
// current resolver independently returns ok with the exact same
// scope+environment, and the store holds a matching, unexpired schema-v2
// record. The window is a neutral truthful 0%-remaining window named observed
// carrying the authoritative resets_at and a concise Chinese message. Legacy
// v1 and mismatched records stay inert; nil context always yields no entry.
func observedCodeBuddyEntry(deps CommandDeps) (providerEntry, bool) {
	expectedScope := strings.TrimSpace(deps.CodeBuddyExpectedScope)
	expectedEnvironment := strings.TrimSpace(deps.CodeBuddyExpectedEnvironment)
	if expectedScope == "" || expectedEnvironment == "" || deps.CodeBuddyActiveScope == nil {
		return providerEntry{}, false
	}
	currentScope, currentEnvironment, ok := deps.CodeBuddyActiveScope()
	if !ok || strings.TrimSpace(currentScope) == "" || strings.TrimSpace(currentEnvironment) == "" {
		return providerEntry{}, false
	}
	if currentScope != expectedScope || currentEnvironment != expectedEnvironment {
		return providerEntry{}, false
	}
	store := observedquota.NewStore(deps.ObservedQuotaRoot)
	record, ok := store.ActiveScoped(observedquota.ProviderCodeBuddy, currentScope, timeNow())
	if !ok {
		return providerEntry{}, false
	}
	label := CanonicalLabel(observedquota.ProviderCodeBuddy)
	resetsAt := record.ResetsAt
	window := Window{
		Name: "observed", Pct: 100, ResetsAt: &resetsAt,
	}
	q := Quota{Provider: observedquota.ProviderCodeBuddy, Label: label, Windows: []Window{window}}
	return providerEntry{
		Provider:    observedquota.ProviderCodeBuddy,
		Label:       label,
		Status:      "ok",
		Windows:     quotaWindowsJSON([]Window{window}),
		DisplayLine: DisplayLine(q),
		Message: fmt.Sprintf(
			"CodeBuddy 额度已耗尽，重置时间为 %s，届时将自动恢复。",
			resetsAt.In(time.Local).Format("2006-01-02 15:04"),
		),
	}, true
}

func quotaShowOne(deps CommandDeps, name string, billing BillingInfo, asJSON, refresh bool) int {
	// Validate canonical name
	canonical := canonicalName(name)
	if canonical == "" {
		fmt.Fprintf(os.Stderr, "forge quota: unknown provider %q; available: %s\n",
			name, strings.Join(canonicalProviders, ", "))
		return 2
	}

	cachePath := providerCachePath(deps.DataDir, canonical)

	// Resolve provider availability before accepting cache.
	provider := innerProviderFor(deps, canonical, billing)
	if deps.ProviderForOverride != nil {
		provider = deps.ProviderForOverride(canonical, billing)
	}
	if provider == nil {
		if asJSON {
			type singleEntry struct {
				Provider string `json:"provider"`
				Label    string `json:"label,omitempty"`
				Status   string `json:"status"`
				Error    string `json:"error"`
			}
			return printJSONQuota(singleEntry{
				Provider: canonical,
				Label:    CanonicalLabel(canonical),
				Status:   "unavailable",
				Error:    "unknown provider",
			})
		}
		fmt.Fprintf(os.Stderr, "forge quota: unavailable %q\n", canonical)
		return 1
	}

	// Check cache (unless --refresh)
	if !refresh {
		if cached, ok := ReadCache(cachePath); ok {
			if cacheEligibleForProvider(cached, canonical) {
				label := CanonicalLabel(canonical)
				cached.Label = label
				dl := DisplayLine(cached)
				if asJSON {
					type singleEntry struct {
						Provider             string            `json:"provider"`
						Label                string            `json:"label,omitempty"`
						Used                 float64           `json:"used"`
						Total                float64           `json:"total"`
						Balances             []MoneyBalance    `json:"balances,omitempty"`
						Windows              []quotaWindowJSON `json:"windows,omitempty"`
						NotApplicableWindows []string          `json:"not_applicable_windows,omitempty"`
						Pace                 *PaceJSON         `json:"pace,omitempty"`
						Reset                *ResetJSON        `json:"reset,omitempty"`
						DisplayLine          string            `json:"display_line,omitempty"`
						FetchedAt            *time.Time        `json:"fetched_at,omitempty"`
						Stale                bool              `json:"stale,omitempty"`
						Status               string            `json:"status"`
						Source               string            `json:"source,omitempty"`
						From                 string            `json:"from,omitempty"`
					}
					pace, reset := PaceAndResetJSON(cached.Windows)
					entry := singleEntry{
						Provider:             canonical,
						Label:                label,
						Used:                 ptrFloatVal(cached.Used),
						Total:                ptrFloatVal(cached.Total),
						Balances:             cached.Balances,
						Windows:              quotaWindowsJSON(cached.Windows),
						NotApplicableWindows: cached.NotApplicableWindows,
						Pace:                 pace,
						Reset:                reset,
						DisplayLine:          dl,
						FetchedAt:            timePtr(cached.FetchedAt),
						Stale:                cached.Stale,
						Status:               "ok",
						Source:               "cache",
						From:                 "cache",
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
		// Fail-closed providers replace any existing valid quota with a failure
		// marker so stale data is never rendered.
		if failClosedProvider(canonical) {
			_ = writeRefreshFailureForce(cachePath, timeNow(), err.Error())
		}
		if asJSON {
			entry := providerEntry{Provider: canonical, Label: CanonicalLabel(canonical)}
			projectQuotaFetchError(&entry, err)
			return printJSONQuota(entry)
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
			Provider             string            `json:"provider"`
			Label                string            `json:"label,omitempty"`
			Used                 float64           `json:"used"`
			Total                float64           `json:"total"`
			Balances             []MoneyBalance    `json:"balances,omitempty"`
			Windows              []quotaWindowJSON `json:"windows,omitempty"`
			NotApplicableWindows []string          `json:"not_applicable_windows,omitempty"`
			DisplayLine          string            `json:"display_line,omitempty"`
			Pace                 *PaceJSON         `json:"pace,omitempty"`
			Reset                *ResetJSON        `json:"reset,omitempty"`
			FetchedAt            *time.Time        `json:"fetched_at,omitempty"`
			Stale                bool              `json:"stale,omitempty"`
			Status               string            `json:"status"`
			Error                string            `json:"error,omitempty"`
			Message              string            `json:"message,omitempty"`
		}
		pace, reset := PaceAndResetJSON(q.Windows)
		entry := singleEntry{
			Provider:             canonical,
			Label:                label,
			Used:                 ptrFloatVal(q.Used),
			Total:                ptrFloatVal(q.Total),
			Balances:             q.Balances,
			Windows:              quotaWindowsJSON(q.Windows),
			NotApplicableWindows: q.NotApplicableWindows,
			DisplayLine:          dl,
			Pace:                 pace,
			Reset:                reset,
			FetchedAt:            timePtr(q.FetchedAt),
			Stale:                q.Stale,
			Status:               "ok",
			Message:              q.Message,
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
	canon, ok := canonicalProviderMap[strings.ToLower(strings.TrimSpace(name))]
	if !ok {
		return ""
	}
	return canon
}

// providerCachePath returns the canonical cache file path for a given provider
// name under the specified data directory.
func providerCachePath(dataDir, providerID string) string {
	return filepath.Join(dataDir, "quota", providerID+".json")
}

// failClosedProvider reports whether the given canonical provider uses a
// fail-closed cache: on fetch failure, stale success data is force-replaced
// with a failure marker so it is never rendered.
func failClosedProvider(providerID string) bool {
	switch providerID {
	case "chatgpt", "cursor", "deepseek", "super-grok":
		return true
	}
	return false
}

// requiredSource returns the exact cache source a fail-closed provider must
// carry to be eligible for direct display. Empty means no source validation.
func requiredSource(providerID string) string {
	switch providerID {
	case "chatgpt":
		return "codex-app-server"
	case "cursor":
		return "cursor-dashboard"
	case "deepseek":
		return "deepseek-balance"
	case "super-grok":
		return superGrokACPSource
	}
	return ""
}

// cacheEligibleForProvider checks whether the given cached Quota is eligible
// for direct command display. The cache is usable when:
//   - FetchedAt is non-zero and age is non-negative and below defaultCacheTTL
//   - For chatgpt/cursor, the source must be exactly the provider's
//     authoritative source (requiredSource).
func cacheEligibleForProvider(cached Quota, providerID string) bool {
	if cached.FetchedAt.IsZero() {
		return false
	}
	age := timeNow().Sub(cached.FetchedAt)
	if age < 0 || age >= defaultCacheTTL {
		return false
	}
	if source := requiredSource(providerID); source != "" && cached.Source != source {
		return false
	}
	return true
}

var canonicalProviderMap = map[string]string{
	"chatgpt":      "chatgpt",
	"codex":        "chatgpt",
	"cursor":       "cursor",
	"deepseek":     "deepseek",
	"ds":           "deepseek",
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
	case "chatgpt":
		return ChatGPTProvider{}
	case "cursor":
		return CursorProvider{}
	case "deepseek":
		var token string
		if deps.ResolveDeepSeekToken != nil {
			token = deps.ResolveDeepSeekToken()
		}
		return DeepSeekProvider{Token: token}
	case "super-grok":
		return SuperGrokProvider{ResolveAuthSources: deps.ResolveSuperGrokAuthSources}
	default:
		return nil
	}
}

func projectQuotaFetchError(entry *providerEntry, err error) {
	entry.Status = "error"
	entry.Error = err.Error()
	var statusErr *QuotaStatusError
	if !errors.As(err, &statusErr) {
		return
	}
	entry.Code = statusErr.Code
	entry.Message = statusErr.Message
	entry.Error = statusErr.Message
	if statusErr.Code != QuotaCodeQueryFailed {
		entry.Status = "unavailable"
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
