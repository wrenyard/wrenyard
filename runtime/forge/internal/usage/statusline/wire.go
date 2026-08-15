package statusline

import (
	"github.com/wrenyard/wrenyard/runtime/forge/internal/profiles/manifest"
)

func ProfileInputsFromManifest(profiles map[string]manifest.Profile) map[string]ProfileInput {
	out := make(map[string]ProfileInput, len(profiles))
	for name, p := range profiles {
		var sc *StatuslineConfig
		if p.Statusline != nil {
			sc = &StatuslineConfig{
				Segments:      p.Statusline.Segments,
				QuotaProvider: p.Statusline.QuotaProvider,
				Billing:       p.Statusline.Billing,
				MaxWidth:      p.Statusline.MaxWidth,
			}
		}
		out[name] = ProfileInput{
			Name: name, Client: p.Client, Provider: p.Provider, SecretRef: p.SecretRef,
			Launcher: p.Launcher, Env: p.Env, Settings: p.Settings, Statusline: sc,
			Supports1M: p.Supports1M, Deprecated: p.Deprecated,
			Reason: p.Reason, Description: p.Description,
		}
	}
	return out
}
