package discovery

import "github.com/wrenyard/wrenyard/runtime/forge/internal/profiles/manifest"

// RefFrom converts a manifest profile to a discovery ProfileRef.
func RefFrom(p manifest.Profile) ProfileRef {
	return ProfileRef{
		Name:        p.Name,
		Client:      p.Client,
		Provider:    p.Provider,
		SecretRef:   p.SecretRef,
		Launcher:    p.Launcher,
		Env:         p.Env,
		Settings:    p.Settings,
		Description: p.Description,
		Supports1M:  p.Supports1M,
		Deprecated:  p.Deprecated,
		Reason:      p.Reason,
	}
}
