package discovery

import (
	"fmt"
	"os"
	"sort"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/profiles/profilepolicy"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

// ProfileDeps bundles explicit callbacks for the profiles discovery command.
type ProfileDeps struct {
	IsProfileEffective          func(profileID string) bool
	ProfileDefinitionExists     func(profileID string) bool
	ProfileAvailabilityReason   func(profileID string) string
	PolicyRegistry              *profilepolicy.Registry
	CanonicalPoolUsagePct       func(canonicalPool string) int
	ProfileDisplayName          func(profileID string) string
	ProfileIDs                  func() []string
	CatalogRegistry             *catalog.Registry
	CatalogBindingAllowedModels func(reg *catalog.Registry, client, provider string) []string
	HasFlag                     func(args []string, flag string) bool
	PrintJSON                   func(value interface{}) int
}

// ProfilesCommand runs the "forge profiles" command.
func ProfilesCommand(deps ProfileDeps, args []string) int {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "forge profiles: expected one of list, show")
		return 2
	}
	switch args[0] {
	case "list":
		return profilesList(deps, args[1:])
	case "show":
		return profilesShow(deps, args[1:])
	default:
		fmt.Fprintf(os.Stderr, "forge profiles: unknown subcommand %s\n", args[0])
		return 2
	}
}

func profilesList(deps ProfileDeps, args []string) int {
	if len(args) == 0 {
		fmt.Println("Profiles:")
		if code := profilesListProfile(deps); code != 0 {
			return code
		}
		fmt.Println("Policies:")
		return profilesListPolicy(deps)
	}
	switch args[0] {
	case "profile":
		return profilesListProfile(deps)
	case "policy":
		return profilesListPolicy(deps)
	default:
		fmt.Fprintf(os.Stderr, "forge profiles list: unknown target %s\n", args[0])
		return 2
	}
}

func profilesListProfile(deps ProfileDeps) int {
	var profiles []EffectiveProfile
	if deps.ProfileDefinitionExists == nil {
		return 0
	}

	// Collect every source-owned profile when the composition root supplies
	// the manifest IDs. The policy walk remains as a compatibility fallback
	// for isolated callers.
	seen := map[string]bool{}
	if deps.ProfileIDs != nil {
		for _, profileID := range deps.ProfileIDs() {
			if seen[profileID] {
				continue
			}
			seen[profileID] = true
			if deps.IsProfileEffective(profileID) {
				profiles = append(profiles, EffectiveProfile{ID: profileID, DisplayName: deps.ProfileDisplayName(profileID)})
			}
		}
	}
	for _, policyID := range deps.PolicyRegistry.List() {
		p, err := deps.PolicyRegistry.Lookup(policyID)
		if err != nil {
			continue
		}
		for _, c := range p.Candidates {
			if seen[c.ProfileID] {
				continue
			}
			seen[c.ProfileID] = true
			if deps.IsProfileEffective(c.ProfileID) {
				displayName := deps.ProfileDisplayName(c.ProfileID)
				profiles = append(profiles, EffectiveProfile{
					ID:          c.ProfileID,
					DisplayName: displayName,
				})
			}
		}
	}

	sort.Slice(profiles, func(i, j int) bool {
		return profiles[i].ID < profiles[j].ID
	})

	for _, p := range profiles {
		fmt.Printf("%s (%s)\n", p.ID, p.DisplayName)
	}
	return 0
}

func profilesListPolicy(deps ProfileDeps) int {
	policyIDs := deps.PolicyRegistry.List()
	sort.Strings(policyIDs)

	for _, pid := range policyIDs {
		p, err := deps.PolicyRegistry.Lookup(pid)
		if err != nil {
			continue
		}
		fmt.Printf("%s:\n", pid)
		for _, c := range p.Candidates {
			effective := deps.IsProfileEffective(c.ProfileID)
			status := "available"
			if !effective {
				status = deps.ProfileAvailabilityReason(c.ProfileID)
			}
			fmt.Printf("  %s: %s\n", c.ProfileID, status)
		}
	}
	return 0
}

func profilesShow(deps ProfileDeps, args []string) int {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "forge profiles show: expected profile name")
		return 2
	}
	name := args[0]

	// Check whether it's a known profile ID (from built-in policies).
	exists := deps.ProfileDefinitionExists(name)
	if !exists {
		fmt.Fprintf(os.Stderr, "forge profiles show: unknown profile %s\n", name)
		return 2
	}

	reason := deps.ProfileAvailabilityReason(name)
	effective := deps.IsProfileEffective(name)

	if effective {
		displayName := deps.ProfileDisplayName(name)
		fmt.Printf("id: %s\ndisplayName: %s\navailable: true\n", name, displayName)
	} else {
		fmt.Printf("id: %s\navailable: false\nreason: %s\n", name, reason)
	}
	return 0
}
