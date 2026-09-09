package forge

import (
	"fmt"
	"os"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/grok"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/driver"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/usage/quota"
	sl "github.com/wrenyard/wrenyard/runtime/forge/internal/usage/statusline"
)

func quotaCommand(args []string) int {
	deps := quota.CommandDeps{
		LoadConfig: loadQuotaConfig,
		DataDir:    forgeDataDir(),
		LoadBilling: func() quota.BillingInfo {
			b := loadBilling()
			return quota.BillingInfo{DefaultQuotaTotal: b.DefaultQuotaTotal}
		},
		ResolveBigModelToken: func() string { return sl.ResolveBigModelToken(statuslineDeps()) },
		ResolveKimiToken:     func() string { return sl.ResolveKimiToken(statuslineDeps()) },
		ResolveDeepSeekToken: resolveDeepSeekQuotaToken,
		CodexBarEnabled:      sl.CodexBarEnabled,
		ResolveSuperGrokAuthSources: func() []string {
			return grok.ReadableOAuthSources(forgeDataDir(), userHome())
		},
		CodeBuddyExpectedScope:       os.Getenv(driver.CodeBuddyExpectedScopeEnv),
		CodeBuddyExpectedEnvironment: os.Getenv(driver.CodeBuddyExpectedEnvironmentEnv),
		CodeBuddyActiveScope: func() (string, string, bool) {
			// Independent current-auth truth: never treat the bound expected
			// environment as observed truth. The values are not logged or
			// exposed here.
			active := authStatusResolver().CodeBuddyActiveScope()
			return active.Scope, active.Environment, active.OK
		},
	}
	return quota.Command(deps, args)
}

// resolveDeepSeekQuotaToken returns the DeepSeek quota bearer token from the
// user-owned DEEPSEEK_API_KEY with FORGE_DEEPSEEK_API_KEY compatibility only.
// DeepSeek is quota-only: it never reads/writes auth.json and never registers
// an inference binding.
func resolveDeepSeekQuotaToken() string {
	for _, key := range []string{"FORGE_DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY"} {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return value
		}
	}
	return ""
}

func statuslineCommand(args []string) int {
	reg, err := loadCatalogRegistry()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return sl.StatuslineCommand(statuslineDepsWithRegistry(reg), args)
}

func statuslineDeps() sl.CommandDeps {
	return statuslineDepsWithRegistry(catalogRegistryOrDefault())
}

func statuslineDepsWithRegistry(reg *catalog.Registry) sl.CommandDeps {
	return sl.CommandDeps{
		LoadConfig:          loadStatuslineConfig,
		LoadManifest:        loadStatuslineProfiles,
		LoadBilling:         loadBilling,
		DataDir:             forgeDataDir(),
		Home:                userHome(),
		ResolveCredential:   ResolveCredential,
		FirstRepoSecret:     firstRepoSecret,
		CodexBarEnabled:     sl.CodexBarEnabled,
		QuotaDisplayEnabled: sl.QuotaDisplayEnabled,
		CatalogRegistry:     reg,
	}
}

func loadStatuslineConfig() (sl.ConfigInfo, []string, error) {
	cfg, warnings, err := LoadForgeConfig()
	return sl.ConfigInfo{
		QuotaStatuslineRenderMs: cfg.Quota.StatuslineRenderMs,
		QuotaStatuslineFetchSec: cfg.Quota.StatuslineFetchSec,
		QuotaStatuslineTTLSec:   cfg.Quota.StatuslineTTLSec,
		QuotaSnapshotStaleMin:   cfg.Quota.SnapshotStaleMin,
		QuotaUsageTTLMin:        cfg.Quota.UsageTTLMin,
	}, warnings, err
}

func loadQuotaConfig() (quota.ConfigInfo, []string, error) {
	cfg, warnings, err := LoadForgeConfig()
	return quota.ConfigInfo{
		QuotaSnapshotStaleMin:   cfg.Quota.SnapshotStaleMin,
		QuotaStatuslineTTLSec:   cfg.Quota.StatuslineTTLSec,
		QuotaStatuslineFetchSec: cfg.Quota.StatuslineFetchSec,
		QuotaStatuslineRenderMs: cfg.Quota.StatuslineRenderMs,
		QuotaUsageTTLMin:        cfg.Quota.UsageTTLMin,
	}, warnings, err
}

func loadStatuslineProfiles() (map[string]sl.ProfileInput, error) {
	m, err := loadManifest()
	if err != nil {
		return nil, err
	}
	return sl.ProfileInputsFromManifest(m.Profiles), nil
}

func loadBilling() sl.Billing { return sl.LoadBillingCatalog(catalogRegistryOrDefault()) }
