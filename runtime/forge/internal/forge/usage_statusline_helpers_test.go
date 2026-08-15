package forge

import (
	"time"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/usage/quota"
	sl "github.com/wrenyard/wrenyard/runtime/forge/internal/usage/statusline"
)

func wiredStatuslineQuotaDeps() sl.CommandDeps { return statuslineDeps() }

func quotaProviderFor(name string, allowCLI bool, interactive bool, swrOnly bool, ttl time.Duration, billing sl.Billing) quota.Provider {
	return sl.QuotaProviderFor(statuslineDeps(), name, allowCLI, interactive, swrOnly, ttl, billing)
}

func quotaDisplayEnabled(name string) bool { return sl.QuotaDisplayEnabled(name) }

func quotaDisplayProviderFor(name string, allowCLI bool, interactive bool, swrOnly bool, ttl time.Duration, billing sl.Billing) quota.Provider {
	return sl.QuotaDisplayProviderFor(statuslineDeps(), name, allowCLI, interactive, swrOnly, ttl, billing)
}

func defaultStatuslineConfig(p profile) statuslineConfig {
	var sc *sl.StatuslineConfig
	if p.Statusline != nil {
		sc = &sl.StatuslineConfig{
			Segments:      p.Statusline.Segments,
			QuotaProvider: p.Statusline.QuotaProvider,
			Billing:       p.Statusline.Billing,
			MaxWidth:      p.Statusline.MaxWidth,
		}
	}
	out := sl.DefaultStatuslineConfig(statuslineDeps(), p.Client, p.Provider, sc)
	return statuslineConfig{
		Segments:      out.Segments,
		QuotaProvider: out.QuotaProvider,
		Billing:       out.Billing,
		MaxWidth:      out.MaxWidth,
	}
}

func openCodeQuotaProviderName(input sl.Input) string {
	return sl.OpenCodeQuotaProviderName(statuslineDeps(), input)
}

func statuslineOpenCodeCommand(input sl.Input, billing sl.Billing, cfg ForgeConfig) int {
	return sl.StatuslineOpenCodeCommand(statuslineDeps(), input, billing, sl.ConfigInfo{
		QuotaStatuslineRenderMs: cfg.Quota.StatuslineRenderMs,
		QuotaStatuslineFetchSec: cfg.Quota.StatuslineFetchSec,
		QuotaStatuslineTTLSec:   cfg.Quota.StatuslineTTLSec,
	})
}

func codexBarEnabled() bool { return sl.CodexBarEnabled() }

func resolveBigModelToken() string { return sl.ResolveBigModelToken(statuslineDeps()) }

func resolveKimiToken() string { return sl.ResolveKimiToken(statuslineDeps()) }
