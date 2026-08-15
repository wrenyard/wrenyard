package selection

import "github.com/wrenyard/wrenyard/runtime/forge/internal/profiles/manifest"

// ProfileFrom converts a manifest profile to the selection DTO.
func ProfileFrom(p manifest.Profile) Profile {
	qp := ""
	if p.Statusline != nil && p.Statusline.QuotaProvider != "" {
		qp = p.Statusline.QuotaProvider
	}
	return Profile{
		Name: p.Name, Client: p.Client, Provider: p.Provider,
		SecretRef:  p.SecretRef,
		Deprecated: p.Deprecated, Reason: p.Reason, QuotaProvider: qp,
	}
}
