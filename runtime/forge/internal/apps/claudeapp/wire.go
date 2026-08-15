package claudeapp

import "github.com/wrenyard/wrenyard/runtime/forge/internal/profiles/manifest"

// ProfileFrom converts a manifest profile to a Claude app profile DTO.
func ProfileFrom(p manifest.Profile) Profile {
	return Profile{
		Name:       p.Name,
		Client:     p.Client,
		Provider:   p.Provider,
		SecretRef:  p.SecretRef,
		Env:        p.Env,
		Settings:   p.Settings,
		Supports1M: p.Supports1M,
		Reason:     p.Reason,
		Deprecated: p.Deprecated,
	}
}

// ProfileToManifest converts a Claude app profile back to a manifest profile.
func ProfileToManifest(p Profile) manifest.Profile {
	return manifest.Profile{
		Name: p.Name, Client: p.Client, Provider: p.Provider,
		SecretRef: p.SecretRef, Env: p.Env, Settings: p.Settings,
		Supports1M: p.Supports1M,
		Reason:     p.Reason, Deprecated: p.Deprecated,
	}
}
