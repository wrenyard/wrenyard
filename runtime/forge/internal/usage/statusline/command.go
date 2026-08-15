package statusline

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/usage/quota"
)

const OpenCodeProviderNotFound = "Provider Not Found"
const openCodeProviderNotFound = OpenCodeProviderNotFound

// CommandDeps bundles explicit dependencies for the statusline command.
type CommandDeps struct {
	// LoadConfig loads the forge config.
	LoadConfig func() (ConfigInfo, []string, error)
	// LoadManifest loads the profile manifest.
	LoadManifest func() (map[string]ProfileInput, error)
	// LoadBilling loads billing data.
	LoadBilling func() Billing
	// DataDir is the forge data directory.
	DataDir string
	// Home is the user home directory.
	Home string
	// ResolveCredential resolves a cred for a provider.
	ResolveCredential func(providerID string) (string, bool)
	// FirstRepoSecret resolves a secret from user/repo stores.
	FirstRepoSecret func(keys ...string) string
	// CodexBarEnabled reports CodexBar state.
	CodexBarEnabled func() bool
	// QuotaDisplayEnabled reports whether a quota provider is displayable.
	QuotaDisplayEnabled func(name string) bool
	// CatalogRegistry is the default catalog registry.
	CatalogRegistry *catalog.Registry
}

// ProfileInput is the minimal profile info passed from root.
type ProfileInput struct {
	Name        string
	Client      string
	Provider    string
	SecretRef   *string
	Launcher    map[string]interface{}
	Env         map[string]string
	Settings    map[string]interface{}
	Statusline  *StatuslineConfig
	Supports1M  bool
	Deprecated  bool
	Reason      string
	Description string
}

// StatuslineConfig mirrors root's statuslineConfig.
type StatuslineConfig struct {
	Segments      []string
	QuotaProvider string
	Billing       string
	MaxWidth      int
}

// ConfigInfo is a neutral view of the forge config for statusline.
type ConfigInfo struct {
	QuotaStatuslineRenderMs int
	QuotaStatuslineFetchSec int
	QuotaStatuslineTTLSec   int
	QuotaSnapshotStaleMin   int
	QuotaUsageTTLMin        int
}

// StatuslineCommand runs the statusline render from stdin JSON.
func StatuslineCommand(deps CommandDeps, args []string) int {
	claudeCodeMode := hasFlag(args, "--claude-code")
	opencodeMode := hasFlag(args, "--opencode")

	if claudeCodeMode && opencodeMode {
		fmt.Fprintln(os.Stderr, "forge statusline: --claude-code and --opencode are mutually exclusive")
		return 2
	}

	// Default to claude-code behavior when neither flag is present.
	if !opencodeMode {
		claudeCodeMode = true
	}

	billing := deps.LoadBilling()
	input, err := ParseInput(os.Stdin)
	if err != nil {
		fmt.Println(Fallback())
		return 0
	}

	cfg, _, _ := deps.LoadConfig()

	if opencodeMode {
		return openCodeCommand(deps, input, billing, cfg)
	}

	profiles, err := deps.LoadManifest()
	if err != nil {
		fmt.Println(Fallback())
		return 0
	}

	profileMap := statuslineProfiles(deps, profiles)
	name := DetectProfile(input, profileMap)
	sp := profileMap[name]
	if sp.Name == "" {
		sp = Profile{Name: "unknown", Segments: []string{"model", "usage", "context"}}
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(cfg.QuotaStatuslineRenderMs)*time.Millisecond)
	defer cancel()

	quotaCtx, quotaCancel := context.WithTimeout(context.Background(), time.Duration(cfg.QuotaStatuslineFetchSec)*time.Second)
	defer quotaCancel()

	statuslineTTL := time.Duration(cfg.QuotaStatuslineTTLSec) * time.Second

	provider := QuotaProviderFor(deps, sp.QuotaProvider, false, false, true, statuslineTTL, billing)

	out := Render(Context{
		Context:       ctx,
		QuotaContext:  quotaCtx,
		Input:         input,
		Profile:       sp,
		Billing:       billing,
		QuotaProvider: provider,
		Home:          deps.Home,
		StatuslineTTL: statuslineTTL,
	})
	fmt.Println(out)
	return 0
}

func openCodeCommand(deps CommandDeps, input Input, billing Billing, cfg ConfigInfo) int {
	providerName := openCodeQuotaProviderName(deps, input)
	if providerName == "" {
		fmt.Println(openCodeProviderNotFound)
		return 0
	}
	statuslineTTL := time.Duration(cfg.QuotaStatuslineTTLSec) * time.Second
	provider := QuotaProviderFor(deps, providerName, false, false, true, statuslineTTL, billing)
	if provider == nil {
		fmt.Println(openCodeProviderNotFound)
		return 0
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(cfg.QuotaStatuslineRenderMs)*time.Millisecond)
	defer cancel()
	quotaCtx, quotaCancel := context.WithTimeout(context.Background(), time.Duration(cfg.QuotaStatuslineFetchSec)*time.Second)
	defer quotaCancel()
	out, err := RenderOpenCodeQuota(Context{
		Context:       ctx,
		QuotaContext:  quotaCtx,
		Input:         input,
		Billing:       billing,
		QuotaProvider: provider,
	}, providerName)
	if err != nil {
		fmt.Println()
		return 0
	}
	fmt.Println(out)
	return 0
}

func openCodeQuotaProviderName(deps CommandDeps, input Input) string {
	var providerName string
	for _, raw := range []string{input.ProviderID, input.Model.ProviderID, input.Model.Provider} {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		canonical := canonicalOpenCodeQuotaProvider(deps, raw)
		if canonical == "" {
			return ""
		}
		if providerName != "" && providerName != canonical {
			return ""
		}
		providerName = canonical
	}
	return providerName
}

func canonicalOpenCodeQuotaProvider(deps CommandDeps, provider string) string {
	module, ok := providers.Lookup(strings.ToLower(strings.TrimSpace(provider)))
	if !ok {
		return ""
	}
	name := module.Quota().Name
	if name == "" || !deps.QuotaDisplayEnabled(name) {
		return ""
	}
	return name
}

func QuotaDisplayEnabled(name string) bool {
	module, ok := providers.Lookup(strings.ToLower(strings.TrimSpace(name)))
	return ok && module.Quota().Kind != "" && module.Quota().Kind != "claude"
}

func statuslineProfiles(deps CommandDeps, manifest map[string]ProfileInput) map[string]Profile {
	out := map[string]Profile{}
	for name, p := range manifest {
		sc := p.Statusline
		cfg := defaultStatuslineConfig(deps, p.Client, p.Provider, sc)
		overrides := map[string]string{}
		if raw, ok := p.Settings["modelOverrides"].(map[string]any); ok {
			for k, v := range raw {
				if s, ok := v.(string); ok {
					overrides[strings.ToLower(k)] = s
				}
			}
		}
		out[name] = Profile{
			Name:           name,
			Client:         p.Client,
			Provider:       p.Provider,
			Segments:       cfg.Segments,
			QuotaProvider:  cfg.QuotaProvider,
			Billing:        cfg.Billing,
			ModelOverrides: overrides,
			MaxWidth:       cfg.MaxWidth,
		}
	}
	return out
}

func defaultStatuslineConfig(deps CommandDeps, client, provider string, sc *StatuslineConfig) statuslineConfigDTO {
	cfg := statuslineConfigDTO{}
	if sc != nil {
		cfg.Segments = sc.Segments
		cfg.QuotaProvider = sc.QuotaProvider
		cfg.Billing = sc.Billing
		cfg.MaxWidth = sc.MaxWidth
	}
	if len(cfg.Segments) == 0 {
		cfg.Segments = nil
	}
	if cfg.Billing == "" {
		cfg.Billing = "default"
	}
	if cfg.QuotaProvider == "" {
		if client != "" {
			reg := deps.CatalogRegistry
			if _, binding, err := reg.ResolveBinding(client, provider); err == nil && binding.QuotaProvider != "" {
				cfg.QuotaProvider = binding.QuotaProvider
			}
		}
	}
	if !deps.QuotaDisplayEnabled(cfg.QuotaProvider) {
		cfg.QuotaProvider = ""
	}
	return cfg
}

type statuslineConfigDTO struct {
	Segments      []string
	QuotaProvider string
	Billing       string
	MaxWidth      int
}

func quotaDisplayProviderFor(deps CommandDeps, name string, allowCLI bool, interactive bool, swrOnly bool, ttl time.Duration, billing Billing) quota.Provider {
	if !deps.QuotaDisplayEnabled(name) {
		return nil
	}
	return QuotaProviderFor(deps, name, allowCLI, interactive, swrOnly, ttl, billing)
}

func QuotaDisplayProviderFor(deps CommandDeps, name string, allowCLI bool, interactive bool, swrOnly bool, ttl time.Duration, billing Billing) quota.Provider {
	return quotaDisplayProviderFor(deps, name, allowCLI, interactive, swrOnly, ttl, billing)
}

// QuotaProviderFor creates a CachedProvider for the given quota name. Exported for root test facades.
func QuotaProviderFor(deps CommandDeps, name string, allowCLI bool, interactive bool, swrOnly bool, ttl time.Duration, billing Billing) quota.Provider {
	if name == "" {
		return nil
	}
	module, ok := providers.Lookup(name)
	if !ok || module.Quota().Kind == "" {
		return nil
	}
	quotaInfo := module.Quota()
	name = quotaInfo.Name
	cachePath := filepath.Join(deps.DataDir, "quota", name+".json")
	cfg, _, _ := deps.LoadConfig()
	var inner quota.Provider
	var refreshAge time.Duration
	switch quotaInfo.Kind {
	case "bigmodel":
		token := resolveBigModelToken(deps)
		inner = quota.BigModelProvider{Token: token}
	case "kimi":
		inner = quota.KimiProvider{Token: resolveKimiToken(deps)}
	case "claude":
		staleDur := time.Duration(cfg.QuotaSnapshotStaleMin) * time.Minute
		inner = quota.ClaudeProvider{
			ProviderName:          name,
			AllowCLI:              allowCLI,
			Interactive:           interactive,
			AllowKeychain:         allowCLI,
			AllowSnapshot:         deps.CodexBarEnabled(),
			SnapshotStaleDuration: staleDur,
		}
	case "codex":
		inner = quota.CodexProvider{
			ProviderName: name,
		}
	default:
		return nil
	}

	// Codex and codex-spark use fail-closed cache: never return expired stale data.
	failClosed := name == "codex" || name == "codex-spark"
	// Codex cache is only usable when produced by the codex-app-server API.
	var requiredSource string
	if failClosed {
		requiredSource = "codex-app-server"
	}
	return &quota.CachedProvider{
		Inner:          inner,
		Path:           cachePath,
		TTL:            ttl,
		RefreshAge:     refreshAge,
		SWROnly:        swrOnly,
		FailClosed:     failClosed,
		RequiredSource: requiredSource,
	}
}

func resolveBigModelToken(deps CommandDeps) string {
	if cred, ok := deps.ResolveCredential("zhipu-coding"); ok && cred != "" {
		return cred
	}
	return deps.FirstRepoSecret("glm-anthropic-auth-token", "glm-Tencent-auth-token", "glm-api-key", "zhipu-api-key")
}

func ResolveBigModelToken(deps CommandDeps) string { return resolveBigModelToken(deps) }

func resolveKimiToken(deps CommandDeps) string {
	if cred, ok := deps.ResolveCredential("kimi-coding"); ok && cred != "" {
		return cred
	}
	for _, key := range []string{"KIMI_CODE_API_KEY", "FORGE_KIMI_CODING_API_KEY", "KIMI_CODING_API_KEY", "MOONSHOT_API_KEY"} {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return value
		}
	}
	return deps.FirstRepoSecret("kimi-coding-api-key", "kimi-api-key", "moonshot-api-key")
}

func ResolveKimiToken(deps CommandDeps) string { return resolveKimiToken(deps) }

func CodexBarEnabled() bool {
	return strings.TrimSpace(os.Getenv("FORGE_QUOTA_CODEXBAR")) == "1"
}

func hasFlag(args []string, flag string) bool {
	for _, arg := range args {
		if arg == flag || strings.HasPrefix(arg, flag+"=") {
			return true
		}
	}
	return false
}

// DefaultStatuslineConfig converts the private DTO result into the public StatuslineConfig.
func DefaultStatuslineConfig(deps CommandDeps, client, provider string, sc *StatuslineConfig) StatuslineConfig {
	dto := defaultStatuslineConfig(deps, client, provider, sc)
	return StatuslineConfig{
		Segments:      dto.Segments,
		QuotaProvider: dto.QuotaProvider,
		Billing:       dto.Billing,
		MaxWidth:      dto.MaxWidth,
	}
}

// OpenCodeQuotaProviderName delegates to the private function.
func OpenCodeQuotaProviderName(deps CommandDeps, input Input) string {
	return openCodeQuotaProviderName(deps, input)
}

// StatuslineOpenCodeCommand delegates to the private function.
func StatuslineOpenCodeCommand(deps CommandDeps, input Input, billing Billing, cfg ConfigInfo) int {
	return openCodeCommand(deps, input, billing, cfg)
}
