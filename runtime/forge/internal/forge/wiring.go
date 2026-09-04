package forge

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/dsh"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/grok"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/lifecycle/change"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/profiles/discovery"
	profilepolicy "github.com/wrenyard/wrenyard/runtime/forge/internal/profiles/profilepolicy"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/profiles/selection"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/auth"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/capability"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/driver"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/execution"
	profilepkg "github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/profile"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/usage/quota"
	sl "github.com/wrenyard/wrenyard/runtime/forge/internal/usage/statusline"
)

// --- capabilities.go ---

type capabilityManifest = capability.Manifest

func loadCapabilityManifest() (capabilityManifest, error) {
	return capability.LoadManifest(userCapabilitiesPath(), capability.EmbeddedData())
}

func normalizeCapabilityNames(names []string) ([]string, error) {
	return capability.NormalizeNames(names)
}

func resolveCapabilityPacks(names []string) (driver.CapabilityResult, error) {
	return capability.ResolvePacks(names, userCapabilitiesPath(), capability.EmbeddedData())
}

// --- availability / selection bridge ---

func selectionDeps() selection.Dependencies {
	return selection.Dependencies{
		LoadForgeConfig:   func() (ForgeConfig, []string, error) { return LoadForgeConfig() },
		ResolveCredential: selectionCredential,
		ResolveSecret:     resolveSecret,
		LoadManifest: func() (map[string]selection.Profile, error) {
			manifest, err := loadManifest()
			if err != nil {
				return nil, err
			}
			out := make(map[string]selection.Profile, len(manifest.Profiles))
			for name, p := range manifest.Profiles {
				out[name] = selection.ProfileFrom(p)
			}
			return out, nil
		},
		ForgeDataDir:        forgeDataDir,
		ClientInstalled:     clientInstalled,
		QuotaDisplayEnabled: sl.QuotaDisplayEnabled,
	}
}

func selectionCredential(providerID string) (string, bool) {
	if providers.CanonicalID(providerID) == providers.SpaceXAIProviderID {
		if _, err := grok.SelectOAuthSource(forgeDataDir(), userHome()); err == nil {
			return "native-oauth-present", true
		}
		return "", false
	}
	return authStatusCredential(providerID)
}

// authStatusCredential resolves credentials using the unified auth SSOT.
// For forge-managed providers, it reads from auth.json. For native providers
// (Codex, Claude), it reads from their respective native auth files.
func authStatusCredential(providerID string) (string, bool) {
	if IsManagedProvider(providerID) {
		return ResolveCredential(providerID)
	}
	resolver := authStatusResolver()
	cred, ok := resolver.Credential(providerID)
	if !ok {
		return "", false
	}
	return cred.Value, true
}

func providerAuthStatus(providerID string) auth.ProviderAuthStatus {
	status := authStatusResolver().ProviderAuthStatus(providerID)
	if !IsManagedProvider(providerID) {
		return status
	}
	if _, ok := ResolveCredential(providerID); ok {
		status.OK = true
		status.Detail = "authenticated"
	}
	return status
}

func profileInstallsShortcut(p profile) bool {
	return selection.ProfileInstallsShortcut(selection.ProfileFrom(p), selectionDeps())
}
func profileMaterializable(p profile) bool {
	return selection.ProfileMaterializable(selection.ProfileFrom(p), selectionDeps())
}
func availableProfileNames(manifest profileManifest) []string {
	out := make(map[string]selection.Profile, len(manifest.Profiles))
	for name, p := range manifest.Profiles {
		out[name] = selection.ProfileFrom(p)
	}
	return selection.AvailableProfileNames(out, selectionDeps())
}

func managedProfileFunctionNames() []string {
	return selection.ManagedProfileFunctionNames(selectionDeps())
}
func managedFunctionNames() []string { return managedProfileFunctionNames() }

func ClientUsability(client string) ClientEnabledReason {
	return selection.ClientUsability(client, selectionDeps())
}
func IsClientEnabled(client string) bool { return selection.IsClientEnabled(client, selectionDeps()) }

// --- policy.go ---

func profileQuotaAvailable(p profile, floorPct int) bool {
	return selection.ProfileQuotaAvailable(selection.ProfileFrom(p), floorPct, selectionDeps())
}

func profileCredentialAvailable(p profile) bool {
	return selection.ProfileCredentialAvailable(selection.ProfileFrom(p), selectionDeps())
}

func profileQuotaProviderName(p profile) string {
	return selection.ProfileQuotaProviderName(selection.ProfileFrom(p), selectionDeps())
}

// --- profilepolicy wiring ---

var policyRegistry = profilepolicy.NewRegistry()

func resolveProfilePolicySelection(policyName string) (string, error) {
	deps := selection.PolicyResolutionDeps{
		LookupPolicy: func(name string) (selection.PolicyRef, error) {
			p, err := policyRegistry.Lookup(name)
			if err != nil {
				return selection.PolicyRef{}, err
			}
			candidates := make([]selection.PolicyCandidateRef, len(p.Candidates))
			for i, c := range p.Candidates {
				candidates[i] = selection.PolicyCandidateRef{
					ProfileID: c.ProfileID,
					Threshold: c.Threshold,
				}
			}
			return selection.PolicyRef{Name: p.Name, Candidates: candidates}, nil
		},
		IsProfileEffective: func(profileID string) bool {
			return isProfileEffective(profileID)
		},
		CanonicalPoolUsagePct: func(canonicalPool string) int {
			return canonicalPoolUsagePct(canonicalPool)
		},
		CanonicalPoolForProfile: canonicalPoolForProfile,
		MaxUsagePctOverride: func(profileID string) int {
			return profileMaxUsageOverride(profileID)
		},
	}

	result, err := selection.ResolveProfilePolicy(policyName, deps)
	if err != nil {
		return "", err
	}
	return result.ProfileID, nil
}

func resolveProfilePolicyCandidates(policyName string) ([]string, error) {
	deps := selection.PolicyResolutionDeps{
		LookupPolicy: func(name string) (selection.PolicyRef, error) {
			p, err := policyRegistry.Lookup(name)
			if err != nil {
				return selection.PolicyRef{}, err
			}
			candidates := make([]selection.PolicyCandidateRef, len(p.Candidates))
			for i, c := range p.Candidates {
				candidates[i] = selection.PolicyCandidateRef{ProfileID: c.ProfileID, Threshold: c.Threshold}
			}
			return selection.PolicyRef{Name: p.Name, Candidates: candidates}, nil
		},
		IsProfileEffective:      isProfileEffective,
		CanonicalPoolUsagePct:   canonicalPoolUsagePct,
		CanonicalPoolForProfile: canonicalPoolForProfile,
		MaxUsagePctOverride:     profileMaxUsageOverride,
	}
	result, err := selection.ResolveProfilePolicy(policyName, deps)
	if err != nil {
		return nil, err
	}
	return append([]string(nil), result.Candidates...), nil
}

func isProfileEffective(profileID string) bool {
	manifest, err := loadManifest()
	if err != nil {
		return false
	}
	p, ok := manifest.Profiles[profileID]
	if !ok {
		return false
	}
	p.Name = profileID
	sp := selection.ProfileFrom(p)
	if p.Client != "" && selection.ClientUsability(p.Client, selectionDeps()) != selection.ClientOK {
		return false
	}
	if !selection.ProfileCredentialAvailable(sp, selectionDeps()) {
		return false
	}
	return true
}

func profileAvailabilityReason(profileID string) string {
	manifest, err := loadManifest()
	if err != nil {
		return "manifest_load_error"
	}
	p, ok := manifest.Profiles[profileID]
	if !ok {
		return "definition_not_found"
	}
	p.Name = profileID
	sp := selection.ProfileFrom(p)
	if p.Client != "" {
		usability := selection.ClientUsability(p.Client, selectionDeps())
		if usability == selection.ClientDisabledByConfig {
			return "client_disabled_by_config"
		}
		if usability != selection.ClientOK {
			return "client_not_installed"
		}
	}
	if !selection.ProfileCredentialAvailable(sp, selectionDeps()) {
		return "provider_auth_missing"
	}
	return "available"
}

func profileDefinitionExists(profileID string) bool {
	manifest, err := loadManifest()
	if err != nil {
		return false
	}
	_, ok := manifest.Profiles[profileID]
	return ok
}

func profileDisplayName(profileID string) string {
	manifest, err := loadManifest()
	if err != nil {
		return profileID
	}
	if p, ok := manifest.Profiles[profileID]; ok {
		if p.Description != "" {
			return p.Description
		}
		if p.Provider != "" {
			return p.Provider
		}
	}
	return profileID
}

func canonicalPoolUsagePct(canonicalPool string) int {
	if canonicalPool == "" {
		return -1
	}
	cachePath := filepath.Join(forgeDataDir(), "quota", canonicalPool+".json")
	q, ok := quota.ReadCache(cachePath)
	if !ok {
		return 0
	}
	if q.Used == nil || q.Total == nil || *q.Total <= 0 {
		return 0
	}
	pct := int((*q.Used / *q.Total) * 100)
	return pct
}

func canonicalPoolForProfile(profileID string) string {
	manifest, err := loadManifest()
	if err != nil {
		return ""
	}
	profile, ok := manifest.Profiles[profileID]
	if !ok {
		return ""
	}
	module, ok := providers.Lookup(profile.Provider)
	if !ok {
		return ""
	}
	return module.Quota().Name
}

func profileMaxUsageOverride(profileID string) int {
	cfg, _, err := LoadForgeConfig()
	if err != nil {
		return 0
	}
	if cfg.PolicyMaxUsagePct != nil {
		if v, ok := cfg.PolicyMaxUsagePct[profileID]; ok && v > 0 {
			return v
		}
	}
	return 0
}

// --- discovery / profiles ---

func isRawClaudeAliasProfile(p profile) bool {
	return p.Provider == "anthropic"
}

func profilesCommand(args []string) int {
	reg, err := loadCatalogRegistry()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return discovery.ProfilesCommand(wiredDiscoveryProfileDeps(reg), args)
}

func providersCommand(args []string) int {
	reg, err := loadCatalogRegistry()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return discovery.ProvidersCommand(wiredDiscoveryProviderDeps(reg), args)
}

func wiredDiscoveryProfileDeps(reg *catalog.Registry) discovery.ProfileDeps {
	return discovery.ProfileDeps{
		IsProfileEffective:        isProfileEffective,
		ProfileDefinitionExists:   profileDefinitionExists,
		ProfileAvailabilityReason: profileAvailabilityReason,
		PolicyRegistry:            policyRegistry,
		CanonicalPoolUsagePct:     canonicalPoolUsagePct,
		ProfileDisplayName:        profileDisplayName,
		ProfileIDs: func() []string {
			manifest, err := loadManifest()
			if err != nil {
				return nil
			}
			ids := make([]string, 0, len(manifest.Profiles))
			for id := range manifest.Profiles {
				ids = append(ids, id)
			}
			sort.Strings(ids)
			return ids
		},
		CatalogRegistry: reg,
		CatalogBindingAllowedModels: func(reg *catalog.Registry, client, provider string) []string {
			_, binding, err := reg.ResolveBinding(client, provider)
			if err != nil {
				return nil
			}
			return binding.AllowedModels
		},
		HasFlag:   func(args []string, flag string) bool { return hasFlag(args, flag) },
		PrintJSON: func(value interface{}) int { return printJSON(value) },
	}
}

func wiredDiscoveryProviderDeps(reg *catalog.Registry) discovery.ProviderDeps {
	return discovery.ProviderDeps{
		CatalogRegistry: reg,
		Auth: discovery.ProviderAuthDeps{
			ProviderLogin: func(providerID string) error {
				return providerLogin(providerID)
			},
			ProviderLogout: func(providerID string) error {
				return providerLogout(providerID)
			},
			ResolveCredential: ResolveCredential,
		},
		AuthStatus: func(providerID string) auth.ProviderAuthStatus {
			return providerAuthStatus(providerID)
		},
		HasFlag:   func(args []string, flag string) bool { return hasFlag(args, flag) },
		PrintJSON: func(value interface{}) int { return printJSON(value) },
	}
}

func authStatusResolver() *auth.ProviderAuthStatusResolver {
	return auth.NewProviderAuthStatusResolver(
		resolveCatalogCredentialResolver,
		forgeDataDir,
		userHome,
	)
}

// resolveCatalogCredentialResolver returns the CredentialResolverKind for a
// provider ID from the catalog, or false if the provider is unknown or has no
// credential source. The top-level CredentialSource works for native
// providers that declare no inference transport.
func resolveCatalogCredentialResolver(providerID string) (auth.CredentialResolverKind, bool) {
	reg := catalogRegistryOrDefault()
	binding, err := reg.LookupBinding(providerID)
	if err != nil {
		return "", false
	}
	source := binding.CredentialSource()
	if source == "" {
		return "", false
	}
	return source, true
}

func discoveryCatalogAllowedModels(reg *catalog.Registry, client, provider string) []string {
	_, binding, err := reg.ResolveBinding(client, provider)
	if err != nil {
		return nil
	}
	return binding.AllowedModels
}

// --- shortcut capabilities ---

func clientEmitsAliasShortcut(client string) bool { return selection.ClientEmitsAliasShortcut(client) }
func providerSupportsCCShortcut(provider string) bool {
	return selection.ProviderSupportsCCShortcut(provider)
}
func shortcutUsesRichCC(p profile) bool {
	return selection.ShortcutUsesRichCC(selection.ProfileFrom(p))
}
func providerCredentialAvailable(p profile) bool {
	return selection.ProviderCredentialAvailable(selection.ProfileFrom(p), selectionDeps())
}

func clientInstalled(client string) bool {
	if strings.TrimSpace(client) == "" {
		return false
	}
	reg := catalogRegistryOrDefault()
	if desc, err := reg.LookupDescriptor(client); err == nil {
		_, err := driver.ResolveBinary(desc.Binary)
		return err == nil
	}
	return lookPath(client)
}

// --- execution wiring ---

func executionDependencies() execution.Dependencies {
	return execution.Dependencies{
		LoadProfile: func(name string) (execution.ProfileDefinition, bool, error) {
			manifest, err := loadManifest()
			if err != nil {
				return execution.ProfileDefinition{}, false, err
			}
			p, ok := manifest.Profiles[name]
			if !ok {
				return execution.ProfileDefinition{}, false, nil
			}
			p.Name = name
			caps := make([]string, len(p.Capabilities))
			copy(caps, p.Capabilities)
			return execution.ProfileDefinition{
				Name: p.Name, Client: p.Client, Provider: p.Provider,
				SecretRef: p.SecretRef, Launcher: p.Launcher, Env: p.Env,
				Settings: p.Settings, Capabilities: caps,
				Supports1M: p.Supports1M,
				Deprecated: p.Deprecated, Reason: p.Reason,
			}, true, nil
		},
		ClientEnabled: func(client string) bool {
			return ClientUsability(client) == ClientOK
		},
		ResolveProfile: func(def execution.ProfileDefinition) (profilepkg.ResolvedProfile, error) {
			plan, err := dispatchPlanForProfile(def.Name)
			if err != nil {
				return profilepkg.ResolvedProfile{}, err
			}
			input := profilepkg.InputProfile{
				Name: def.Name, Client: def.Client, Provider: def.Provider,
				SecretRef: def.SecretRef, Launcher: def.Launcher,
				Env: def.Env, Settings: def.Settings,
			}
			client, err := catalogRegistryOrDefault().LookupDescriptor(plan.Client)
			if err != nil {
				return profilepkg.ResolvedProfile{}, fmt.Errorf("dispatch plan for profile %q has no client adapter: %w", def.Name, err)
			}
			module, ok := providers.Lookup(plan.Provider)
			if !ok {
				return profilepkg.ResolvedProfile{}, fmt.Errorf("dispatch plan for profile %q has no provider adapter", def.Name)
			}
			return profilepkg.ResolveDispatch(input, plan, client, module.Binding(), wiredProfileCallbacks())
		},
		PrepareRuntime:      prepareClientRuntime,
		DataDir:             forgeDataDir(),
		ResolveCapabilities: resolveCapabilityPacks,
	}
}

func prepareClientRuntime(def execution.ProfileDefinition, resolved profilepkg.ResolvedProfile) (driver.RuntimePreparation, error) {
	if resolved.Provider.GatewayRouted {
		return prepareGatewayClientRuntime(def, resolved)
	}
	if def.Client == "dsh" {
		return driver.RuntimePreparation{}, fmt.Errorf("dsh requires a Model Gateway run combination")
	}
	if def.Client == "codex" {
		prep := driver.RuntimePreparation{}
		codexHome := strings.TrimSpace(os.Getenv("CODEX_HOME"))
		if codexHome == "" {
			codexHome = filepath.Join(userHome(), ".codex")
		}
		appendRuntimeSensitiveSource(&prep, filepath.Join(codexHome, "auth.json"))
		return prep, nil
	}
	if def.Client != "grok" {
		return driver.RuntimePreparation{}, nil
	}
	selectedProvider := strings.TrimSpace(resolved.Provider.Name)
	if selectedProvider != providers.SpaceXAIProviderID {
		return driver.RuntimePreparation{}, fmt.Errorf("non-native Grok provider %q requires a Model Gateway run combination", selectedProvider)
	}
	configData, err := grok.AgentConfigBytes(nil, strings.TrimSpace(def.Env["GROK_MODEL"]))
	if err != nil {
		return driver.RuntimePreparation{}, err
	}
	prep := driver.RuntimePreparation{
		HomeParent: grok.AgentHomeParent(forgeDataDir()),
		HomeEnvVar: "GROK_HOME",
		Env:        map[string]string{},
		Files: []driver.PreparedFile{
			{RelativePath: "config.toml", Data: configData, Mode: 0o600},
		},
	}
	for _, path := range grok.ReadableOAuthSources(forgeDataDir(), userHome()) {
		appendRuntimeSensitiveSource(&prep, path)
	}
	oauth, err := grok.PrepareOAuth(forgeDataDir(), userHome())
	if err != nil {
		return driver.RuntimePreparation{}, err
	}
	prep.Copies = append(prep.Copies, driver.PreparedCopy{SourcePath: oauth.SourcePath, RelativePath: "auth.json", Mode: 0o600, Sensitive: true})
	for _, path := range oauth.ReadablePaths {
		appendRuntimeSensitiveSource(&prep, path)
	}
	return prep, nil
}

func prepareGatewayClientRuntime(def execution.ProfileDefinition, resolved profilepkg.ResolvedProfile) (driver.RuntimePreparation, error) {
	token := strings.TrimSpace(os.Getenv("WRENYARD_GATEWAY_TOKEN"))
	if token == "" {
		return driver.RuntimePreparation{}, fmt.Errorf("model Gateway connection is unavailable")
	}
	urlEnv := map[catalog.GatewayProtocol]string{
		catalog.GatewayProtocolOpenAIChat:      "WRENYARD_GATEWAY_OPENAI_CHAT_URL",
		catalog.GatewayProtocolOpenAIResponses: "WRENYARD_GATEWAY_OPENAI_RESPONSES_URL",
		catalog.GatewayProtocolAnthropic:       "WRENYARD_GATEWAY_ANTHROPIC_URL",
	}[resolved.Provider.GatewayProtocol]
	baseURL := strings.TrimSpace(os.Getenv(urlEnv))
	if baseURL == "" {
		return driver.RuntimePreparation{}, fmt.Errorf("model Gateway protocol %q is unavailable", resolved.Provider.GatewayProtocol)
	}
	modelDef := catalog.ModelDef{ID: resolved.Provider.DefaultModel, DisplayName: resolved.Provider.DefaultModel}
	publicModel := resolved.Provider.Name + "/" + resolved.Provider.DefaultModel
	prep := driver.RuntimePreparation{
		Env: map[string]string{
			"WRENYARD_GATEWAY_TOKEN": token,
			urlEnv:                   baseURL,
		},
		SensitiveEnvKeys: []string{"WRENYARD_GATEWAY_TOKEN"},
	}
	if def.Client == "dsh" {
		prep.HomeParent = filepath.Join(forgeDataDir(), "dsh")
		prep.HomeEnvVar = "DSH_HOME"
		provider := dsh.GatewayProvider(baseURL, gatewayModelsFromEnvironment())
		assets := dsh.DefaultRuntimePatchAssets()
		patch, patchErr := dsh.RenderPatch(dsh.PatchInput{
			Providers: []dsh.Provider{provider}, SelectedModel: dsh.GatewayProviderID + "/" + publicModel, Version: dsh.ProtocolVersion,
		})
		if patchErr != nil {
			return driver.RuntimePreparation{}, patchErr
		}
		prep.Files = []driver.PreparedFile{
			{RelativePath: assets.PatchPath, Data: patch, Mode: 0o600},
			{RelativePath: assets.Plugin.Filename, Data: []byte(assets.Plugin.Source), Mode: 0o600},
		}
		return prep, nil
	}
	if def.Client == "grok" {
		projection := grok.ProjectModel(resolved.Provider.Name, baseURL+"/chat/completions", modelDef)
		projection.Model = publicModel
		projection.EnvKey = "WRENYARD_GATEWAY_TOKEN"
		configData, configErr := grok.AgentConfigBytes([]grok.Projection{projection}, projection.ID)
		if configErr != nil {
			return driver.RuntimePreparation{}, configErr
		}
		prep.HomeParent = grok.AgentHomeParent(forgeDataDir())
		prep.HomeEnvVar = "GROK_HOME"
		prep.Files = []driver.PreparedFile{{RelativePath: "config.toml", Data: configData, Mode: 0o600}}
	}
	return prep, nil
}

func gatewayModelsFromEnvironment() []dsh.Model {
	raw := strings.TrimSpace(os.Getenv("WRENYARD_GATEWAY_MODELS_JSON"))
	if raw == "" {
		return nil
	}
	var available []struct {
		PublicID      string `json:"publicId"`
		Provider      string `json:"provider"`
		ID            string `json:"id"`
		DisplayName   string `json:"displayName"`
		ContextWindow int    `json:"contextWindow"`
		MaxTokens     int    `json:"maxTokens"`
	}
	if json.Unmarshal([]byte(raw), &available) != nil {
		return nil
	}
	out := make([]dsh.Model, 0, len(available))
	for _, model := range available {
		out = append(out, dsh.Model{ID: model.PublicID, Label: model.DisplayName, ContextWindow: model.ContextWindow, MaxTokens: model.MaxTokens})
	}
	return out
}

func dispatchPlanForProfile(profileID string) (profilepkg.DispatchPlan, error) {
	raw := strings.TrimSpace(os.Getenv("WRENYARD_DISPATCH_PLANS_JSON"))
	if raw == "" {
		return profilepkg.DispatchPlan{}, fmt.Errorf("dispatch plan for profile %q is unavailable", profileID)
	}
	var plans map[string]profilepkg.DispatchPlan
	if err := json.Unmarshal([]byte(raw), &plans); err != nil {
		return profilepkg.DispatchPlan{}, fmt.Errorf("dispatch plans are invalid: %w", err)
	}
	plan, ok := plans[profileID]
	if !ok {
		return profilepkg.DispatchPlan{}, fmt.Errorf("dispatch plan for profile %q is unavailable", profileID)
	}
	return plan, nil
}

func appendRuntimeSensitiveSource(prep *driver.RuntimePreparation, path string) {
	path = strings.TrimSpace(path)
	if path == "" {
		return
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return
	}
	file, err := os.Open(path)
	if err != nil {
		return
	}
	_, readErr := io.Copy(io.Discard, file)
	closeErr := file.Close()
	if readErr != nil || closeErr != nil {
		return
	}
	for _, existing := range prep.SensitiveSources {
		if sameRuntimeSourcePath(existing.Path, path) {
			return
		}
	}
	prep.SensitiveSources = append(prep.SensitiveSources, driver.PreparedSensitiveSource{Path: path})
}

func sameRuntimeSourcePath(left, right string) bool {
	left = filepath.Clean(left)
	right = filepath.Clean(right)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(left, right)
	}
	return left == right
}

// --- profile callbacks ---

func wiredProfileCallbacks() profilepkg.Callbacks {
	return profilepkg.Callbacks{
		Credential: profilepkg.CredentialCallbacks{
			ResolveSecret: func(ref *string) (*string, bool, error) {
				resolved, err := resolveSecret(ref)
				if err != nil {
					return nil, false, err
				}
				if ref != nil && resolved == nil && strings.HasPrefix(*ref, "profile:") {
					return nil, true, nil
				}
				return resolved, false, nil
			},
			ResolveProviderCredential: func(providerID string) (string, bool) {
				return authStatusCredential(providerID)
			},
			IsManagedProvider: func(providerID string) bool {
				return IsManagedProvider(providerID)
			},
		},
	}
}

func resolveProfileSnapshot(p profile, reg *catalog.Registry) (profilepkg.ResolvedProfile, error) {
	plan, err := dispatchPlanForProfile(p.Name)
	if err != nil {
		return profilepkg.ResolvedProfile{}, err
	}
	input := profilepkg.InputProfile{
		Name: p.Name, Client: p.Client, Provider: p.Provider,
		SecretRef: p.SecretRef, Launcher: p.Launcher,
		Env: p.Env, Settings: p.Settings,
	}
	client, err := reg.LookupDescriptor(plan.Client)
	if err != nil {
		return profilepkg.ResolvedProfile{}, err
	}
	module, ok := providers.Lookup(plan.Provider)
	if !ok {
		return profilepkg.ResolvedProfile{}, fmt.Errorf("dispatch plan for profile %q has no provider adapter", p.Name)
	}
	return profilepkg.ResolveDispatch(input, plan, client, module.Binding(), wiredProfileCallbacks())
}

// --- apply.go ---

func applyPlan(plan changePlan, dryRun bool) applyResult {
	result := change.Apply(change.Plan(plan), dryRun, change.Dependencies{
		Home:   userHome(),
		Redact: redact,
	})
	return applyResult(result)
}

func planJournal(plan changePlan) map[string]interface{} {
	return change.PlanJournal(change.Plan(plan))
}

func backupRelativePath(path string) string {
	return change.BackupRelativePath(path)
}

func providerModelDisplayName(providerID, modelID string) string {
	model, ok := catalogRegistryOrDefault().ProviderModels(providerID)[modelID]
	if !ok {
		return ""
	}
	return model.DisplayName
}
