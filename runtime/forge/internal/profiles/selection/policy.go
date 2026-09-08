package selection

import (
	"path/filepath"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/usage/quota"
)

// ProfileQuotaAvailable checks whether a profile's quota provider usage
// is below the floor percentage. Unknown quota = available (no blocking).
func ProfileQuotaAvailable(p Profile, floorPct int, deps Dependencies) bool {
	qp := ProfileQuotaProviderName(p, deps)
	if qp == "" {
		return true
	}
	cachePath := filepath.Join(deps.ForgeDataDir(), "quota", qp+".json")
	q, ok := quota.ReadCache(cachePath)
	if !ok {
		return true
	}
	if q.Used == nil || q.Total == nil || *q.Total <= 0 {
		return true
	}
	pct := (*q.Used / *q.Total) * 100
	return int(pct) < floorPct
}

// ProfileCredentialAvailable checks whether a profile's provider has a
// resolvable credential. It delegates to ProviderCredentialAvailable for all
// providers, including native-login providers.
func ProfileCredentialAvailable(p Profile, deps Dependencies) bool {
	if p.Provider == "" {
		return true
	}
	return ProviderCredentialAvailable(p, deps)
}

// ProfileQuotaProviderName resolves the quota provider name for a profile.
func ProfileQuotaProviderName(p Profile, deps Dependencies) string {
	return displayQuotaProviderName(resolveProfileQuotaProviderName(p), deps)
}

func displayQuotaProviderName(name string, deps Dependencies) string {
	name = strings.TrimSpace(name)
	if !deps.QuotaDisplayEnabled(name) {
		return ""
	}
	return name
}

func resolveProfileQuotaProviderName(p Profile) string {
	if p.QuotaProvider != "" {
		return p.QuotaProvider
	}
	if module, ok := providers.Lookup(p.Provider); ok {
		return module.Quota().Name
	}
	return ""
}
