package doctor

import (
	"sort"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/profiles/config"
)

// ClientsDoctorChecks reports on configured clients.
func ClientsDoctorChecks(deps Dependencies) []map[string]interface{} {
	cfg, _, err := deps.LoadForgeConfig()
	if err != nil {
		return []map[string]interface{}{Check("clients", "error", "Failed to load clients from forge config.", nil, map[string]interface{}{"error": err.Error()})}
	}

	details := map[string]interface{}{}
	status := "ok"
	ids := SortedClientKeys(cfg)
	if deps.ClientIDs != nil {
		seen := make(map[string]bool, len(ids))
		for _, id := range ids {
			seen[id] = true
		}
		for _, id := range deps.ClientIDs() {
			if !seen[id] {
				ids = append(ids, id)
				seen[id] = true
			}
		}
		sort.Strings(ids)
	}
	for _, id := range ids {
		enabled := cfg.IsClientEnabled(id)
		installed := deps.ClientInstalled(id)
		details[id] = map[string]interface{}{
			"enabled":   enabled,
			"installed": installed,
		}
		if enabled && !installed {
			status = "warning"
		}
	}
	if status == "warning" {
		return []map[string]interface{}{Check("clients", status, "One or more enabled clients are not installed.", nil, details)}
	}
	return []map[string]interface{}{Check("clients", status, "Configured clients are installed or disabled.", nil, details)}
}

// ProvidersDoctorChecks reports on configured providers.
func ProvidersDoctorChecks(deps Dependencies) []map[string]interface{} {
	// Providers are no longer user-defined in config. Report source-owned
	// catalog providers with credential status.
	details := map[string]interface{}{}
	status := "ok"

	// Source providers have no user config to check; they are builtins.
	// Credential availability is validated per-profile (see ProfilesDoctorChecks).

	return []map[string]interface{}{Check("providers", status, "Source-owned catalog providers active.", nil, details)}
}

// ProfilesDoctorChecks validates profile client and provider references using
// the source-owned manifest and effective resolver.
func ProfilesDoctorChecks(deps Dependencies) []map[string]interface{} {
	cfg, _, err := deps.LoadForgeConfig()
	if err != nil {
		return []map[string]interface{}{Check("profiles", "error", "Failed to load forge config for profile checks.", nil, map[string]interface{}{"error": err.Error()})}
	}
	manifest, err := deps.LoadManifest()
	if err != nil {
		return []map[string]interface{}{Check("profiles", "error", "Failed to load Forge profile manifest for accuracy checks.", nil, map[string]interface{}{"error": err.Error()})}
	}

	status := "ok"
	nonOK := []map[string]interface{}{}
	for _, name := range SortedProfileKeys(manifest.Profiles) {
		p := manifest.Profiles[name]
		reason, severity := profileAvailabilityCheck(deps, cfg, p)
		if severity == "ok" {
			continue
		}
		status = WorstStatus(status, severity)
		nonOK = append(nonOK, map[string]interface{}{
			"profile":  name,
			"client":   p.Client,
			"provider": p.Provider,
			"reason":   reason,
		})
	}

	details := map[string]interface{}{
		"non_ok": nonOK,
	}
	if status == "error" {
		return []map[string]interface{}{Check("profiles", status, "One or more profiles reference unknown clients or providers.", nil, details)}
	}
	if status == "warning" {
		return []map[string]interface{}{Check("profiles", status, "One or more profiles have setup gaps.", nil, details)}
	}
	return []map[string]interface{}{Check("profiles", status, "Source-owned profiles are valid.", nil, details)}
}

func profileAvailabilityCheck(deps Dependencies, cfg config.Config, p Profile) (string, string) {
	// Client ownership comes from the source catalog. An absent key in an
	// older user config means enabled by default; it does not make a newly
	// introduced source client unknown.
	if p.Client != "" && deps.ClientKnown != nil && !deps.ClientKnown(p.Client) {
		return "unknown_client", "error"
	}
	// Check client installation.
	if cfg.IsClientEnabled(p.Client) && !deps.ClientInstalled(p.Client) {
		return "client_not_installed", "warning"
	}
	// Check provider credentials using the unified auth SSOT.
	if deps.ProviderCredentialAvailable != nil && !deps.ProviderCredentialAvailable(p) {
		return "provider_auth_missing", "warning"
	}
	return "", "ok"
}

func shortcutUsesRichCC(deps Dependencies, p Profile) bool {
	return deps.IsCCShortcutProvider(p.Provider)
}

// providerCredentialAvailableDefault is the default implementation used when
// no ProviderCredentialAvailable callback is set.
func ProviderCredentialAvailable(deps Dependencies, p Profile) bool {
	if deps.ProviderCredentialAvailable != nil {
		return deps.ProviderCredentialAvailable(p)
	}
	if !deps.IsCCShortcutProvider(p.Provider) {
		if p.SecretRef != nil && deps.ResolveSecretRef != nil {
			resolved, err := deps.ResolveSecretRef(p.SecretRef)
			return err == nil && resolved != nil && *resolved != ""
		}
		_, ok := deps.ResolveCredential(p.Provider)
		return ok
	}
	if p.SecretRef != nil && deps.ResolveSecretRef != nil {
		resolved, err := deps.ResolveSecretRef(p.SecretRef)
		if err == nil && resolved != nil && *resolved != "" {
			return true
		}
		return false
	}
	_, ok := deps.ResolveCredential(p.Provider)
	return ok
}
