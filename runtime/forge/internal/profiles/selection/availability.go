package selection

import "sort"

// ProfileInstallsShortcut reports whether a profile should install a shell shortcut.
func ProfileInstallsShortcut(p Profile, deps Dependencies) bool {
	return ClientEmitsAliasShortcut(p.Client) &&
		deps.ClientInstalled(p.Client) &&
		(!ShortcutUsesRichCC(p) || ProviderCredentialAvailable(p, deps))
}

// ProfileMaterializable reports whether a profile's configuration can be materialized on disk.
func ProfileMaterializable(p Profile, deps Dependencies) bool {
	return deps.ClientInstalled(p.Client) &&
		IsClientEnabled(p.Client, deps) &&
		ProviderCredentialAvailable(p, deps)
}

// AvailableProfileNames returns a sorted list of discoverable profile names from the given manifest.
func AvailableProfileNames(manifest map[string]Profile, deps Dependencies) []string {
	out := []string{}
	for name, p := range manifest {
		if p.Client != "" && ClientUsability(p.Client, deps) == ClientDisabledByConfig {
			continue
		}
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// ClientUsability checks whether a client is usable.
func ClientUsability(client string, deps Dependencies) ClientEnabledReason {
	if !IsClientEnabled(client, deps) {
		return ClientDisabledByConfig
	}
	return ClientOK
}

// IsClientEnabled reports whether a client is enabled in config (default true).
func IsClientEnabled(client string, deps Dependencies) bool {
	cfg, _, err := deps.LoadForgeConfig()
	if err != nil {
		return true
	}
	return cfg.IsClientEnabled(client)
}

// ManagedProfileFunctionNames returns a sorted list of profile names that
// install shell shortcuts, data-driven from the merged profile set.
func ManagedProfileFunctionNames(deps Dependencies) []string {
	manifest, err := deps.LoadManifest()
	if err != nil {
		return nil
	}
	out := []string{}
	for name, p := range manifest {
		if !ProfileInstallsShortcut(p, deps) {
			continue
		}
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}
