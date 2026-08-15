package grok

import (
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

// Plan is a read-only description of what `forge shell grok` would do. It
// never contains credential values.
type Plan struct {
	Paths       Paths
	Projections []Projection
	Skips       []SkipReason
	// MissingCredentials lists provider ids whose credential is absent.
	MissingCredentials []string
	// OverlayValid is nil when the optional overlay is absent or valid,
	// otherwise it describes why the overlay is invalid.
	OverlayValid error
}

// BuildPlan computes the plan from the registry and credential resolver. It
// does not materialize config or read credential values.
func BuildPlan(reg *catalog.Registry, resolveCredential func(string) (string, bool)) Plan {
	projections, skips := EligibleProjections(reg, resolveCredential)
	plan := Plan{
		Paths:       ResolvePaths(),
		Projections: projections,
		Skips:       skips,
	}
	missing := map[string]bool{}
	for _, s := range skips {
		if s.ModelID == "" {
			continue
		}
		if s.Reason == "no forge-managed credential resolved for provider" {
			missing[s.ProviderID] = true
		}
	}
	for id := range missing {
		plan.MissingCredentials = append(plan.MissingCredentials, id)
	}
	plan.OverlayValid = CheckOverlay(plan.Paths.OverlayPath)
	return plan
}
