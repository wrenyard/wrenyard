package selection

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/profiles/profilepolicy"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/usage/quota"
)

// ResolveProfilePolicy resolves a named policy through the profilepolicy
// registry and resolver. Returns the selected profile ID on success.
func ResolveProfilePolicy(policyName string, deps PolicyResolutionDeps) (ProfilePolicyResolutionResult, error) {
	if policyName == "" || policyName == "auto" {
		return ProfilePolicyResolutionResult{}, fmt.Errorf("unknown policy %q", policyName)
	}

	ref, err := deps.LookupPolicy(policyName)
	if err != nil {
		return ProfilePolicyResolutionResult{}, err
	}

	candidates := make([]profilepolicy.Candidate, len(ref.Candidates))
	for i, c := range ref.Candidates {
		candidates[i] = profilepolicy.Candidate{
			ProfileID: c.ProfileID,
			Threshold: c.Threshold,
		}
	}

	pp := profilepolicy.ProfilePolicy{
		Name:       ref.Name,
		Candidates: candidates,
	}

	overrideThresholds := make(map[string]int)
	for _, c := range ref.Candidates {
		if v := deps.MaxUsagePctOverride(c.ProfileID); v > 0 {
			overrideThresholds[c.ProfileID] = v
		}
	}

	res := profilepolicy.Resolve(
		profilepolicy.ResolveRequest{Policy: pp},
		profilepolicy.Dependencies{
			IsProfileEffective:      deps.IsProfileEffective,
			CanonicalPoolUsagePct:   deps.CanonicalPoolUsagePct,
			CanonicalPoolForProfile: deps.CanonicalPoolForProfile,
		},
		overrideThresholds,
	)

	if !res.OK {
		return ProfilePolicyResolutionResult{}, fmt.Errorf(
			"no available profile in policy %q; suggestions: %s",
			policyName, strings.Join(res.Suggestions, ", "),
		)
	}

	return ProfilePolicyResolutionResult{
		ProfileID:  res.ProfileID,
		PolicyName: res.PolicyName,
		Candidates: append([]string(nil), res.CandidateIDs...),
	}, nil
}

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
