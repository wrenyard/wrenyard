package forge

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/apps/claudeapp"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/dsh"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/grok"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/lifecycle/change"
	shellpkg "github.com/wrenyard/wrenyard/runtime/forge/internal/lifecycle/shell"
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
		CallLLM:             callLLM,
		ForgeDataDir:        forgeDataDir,
		ClientInstalled:     clientInstalled,
		QuotaDisplayEnabled: sl.QuotaDisplayEnabled,
	}
}

func selectionCredential(providerID string) (string, bool) {
	if providerID == "xai" {
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
	if p.Client != "" && selection.ClientUsability(p.Client, selectionDeps()) == selection.ClientDisabledByConfig {
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
	if p.Client != "" && selection.ClientUsability(p.Client, selectionDeps()) == selection.ClientDisabledByConfig {
		return "client_missing"
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
			input := profilepkg.InputProfile{
				Name: def.Name, Client: def.Client, Provider: def.Provider,
				SecretRef: def.SecretRef, Launcher: def.Launcher,
				Env: def.Env, Settings: def.Settings,
			}
			return profilepkg.Resolve(input, catalogRegistryOrDefault(), wiredProfileCallbacks())
		},
		PrepareRuntime:      prepareClientRuntime,
		DataDir:             forgeDataDir(),
		ResolveCapabilities: resolveCapabilityPacks,
	}
}

func prepareClientRuntime(def execution.ProfileDefinition, resolved profilepkg.ResolvedProfile) (driver.RuntimePreparation, error) {
	if def.Client == "dsh" {
		return prepareDSHRuntime(def, resolved)
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
	reg := catalogRegistryOrDefault()
	selectedProvider := strings.TrimSpace(resolved.Provider.Name)
	selectedCredential := resolved.Credential.Value
	selectedForgeManaged := false
	provider := resolved.Provider
	if provider.Name == "" && selectedProvider != "" {
		provider, _ = reg.LookupBinding(selectedProvider)
	}
	if provider.Inference != nil && provider.CredentialSource() == catalog.CredentialResolverForgeManaged {
		selectedForgeManaged = true
	}
	projectionCredential := func(providerID string) (string, bool) {
		if selectedForgeManaged && providerID == selectedProvider {
			return selectedCredential, strings.TrimSpace(selectedCredential) != ""
		}
		return ResolveCredential(providerID)
	}
	projections, _ := grok.EligibleProjections(reg, projectionCredential)
	configData, err := grok.AgentConfigBytes(projections, strings.TrimSpace(def.Env["GROK_MODEL"]))
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
	// Projection evaluates the Forge store for every eligible managed provider,
	// regardless of which credential ultimately wins. Protect that readable
	// source even for xAI OAuth and profile secret_ref runs, and protect every
	// readable native OAuth candidate without copying an unselected credential.
	appendRuntimeSensitiveSource(&prep, authPath())
	for _, path := range grok.ReadableOAuthSources(forgeDataDir(), userHome()) {
		appendRuntimeSensitiveSource(&prep, path)
	}
	// The complete eligible projection remains secret-free in config.toml, but
	// a fixed-model headless child receives only its selected Forge-managed
	// provider credential. Other models retain env_key references without a
	// corresponding secret in this process.
	if selectedForgeManaged && strings.TrimSpace(selectedCredential) != "" {
		for _, projection := range projections {
			if projection.ProviderID != selectedProvider {
				continue
			}
			prep.Env[projection.EnvKey] = selectedCredential
			prep.SensitiveEnvKeys = []string{projection.EnvKey}
			break
		}
	}
	if selectedProvider == "xai" {
		oauth, err := grok.PrepareOAuth(forgeDataDir(), userHome())
		if err != nil {
			return driver.RuntimePreparation{}, err
		}
		prep.Copies = append(prep.Copies, driver.PreparedCopy{SourcePath: oauth.SourcePath, RelativePath: "auth.json", Mode: 0o600, Sensitive: true})
		for _, path := range oauth.ReadablePaths {
			appendRuntimeSensitiveSource(&prep, path)
		}
	}
	return prep, nil
}

// prepareDSHRuntime prepares the DSH background-agent runtime for a dsh
// profile. It allocates the per-run DSH_HOME parent, resolves the selected
// profile typed credential (token plus HTTP context headers) only at launch
// (child env, never files), and renders the secret-free provider/runtime patch
// plus the embedded bridge plugin into prepared assets. Provider routes always
// stay visible; a missing credential only omits the child env value. MCP
// capability projection stays at the driver planner where per-invocation
// capabilities are resolved. Foreman is never exposed to the DSH child.
func prepareDSHRuntime(def execution.ProfileDefinition, resolved profilepkg.ResolvedProfile) (driver.RuntimePreparation, error) {
	prep := driver.RuntimePreparation{
		HomeParent: filepath.Join(forgeDataDir(), "dsh"),
		HomeEnvVar: "DSH_HOME",
		Env:        map[string]string{},
	}

	// Selected profile credential wins and is resolved only at launch: the
	// generated assets carry the scrubbed env name and unquoted !!js process.env
	// refs, never the value. Only the selected provider's token/headers are
	// injected; all routes stay visible.
	selectedProvider := strings.TrimSpace(resolved.Provider.Name)
	selected, ok := dshInjectedProvider(selectedProvider)

	projections := make([]dsh.ProviderProjection, 0, len(dsh.InjectedProviders))
	for _, p := range dsh.InjectedProviders {
		typed := dsh.TypedCredential{}
		if ok && p.ID == selected.ID {
			forgeID := strings.TrimPrefix(p.ID, "llm-pi-ai.")
			typed, _ = dshCredentialResolver(forgeID)
			if strings.TrimSpace(typed.Token) == "" && strings.TrimSpace(resolved.Credential.Value) != "" {
				typed.Token = resolved.Credential.Value
			}
		}
		projections = append(projections, dsh.ProjectProvider(p, typed))
	}
	for _, proj := range projections {
		for name, value := range proj.Env {
			prep.Env[name] = value
		}
	}
	if len(prep.Env) > 0 {
		keys := make([]string, 0, len(prep.Env))
		for name := range prep.Env {
			keys = append(keys, name)
		}
		sort.Strings(keys)
		prep.SensitiveEnvKeys = keys
	}

	providers := make([]dsh.Provider, 0, len(projections))
	for _, proj := range projections {
		providers = append(providers, proj.Provider)
	}
	assets := dsh.DefaultRuntimePatchAssets()
	patch, err := dsh.RenderPatch(dsh.PatchInput{
		Providers:     providers,
		SelectedModel: dshPatchModel(strings.TrimSpace(def.Env[catalog.EnvDSHModel])),
		Version:       dsh.ProtocolVersion,
	})
	if err != nil {
		return driver.RuntimePreparation{}, err
	}
	prep.Files = []driver.PreparedFile{
		{RelativePath: assets.PatchPath, Data: patch, Mode: 0o600},
		{RelativePath: assets.Plugin.Filename, Data: []byte(assets.Plugin.Source), Mode: 0o600},
	}
	// Protect readable credential stores so the child cannot inspect them.
	appendRuntimeSensitiveSource(&prep, authPath())
	return prep, nil
}

// dshInjectedProvider resolves a catalog provider name onto the injected
// llm-pi-ai provider space used by DSH patch rendering. An already-injected id
// is accepted directly; a bare injected name is tried with the llm-pi-ai
// prefix.
func dshInjectedProvider(name string) (dsh.Provider, bool) {
	if p, ok := dsh.ProviderByID(name); ok {
		return p, true
	}
	if strings.TrimSpace(name) != "" {
		return dsh.ProviderByID("llm-pi-ai." + name)
	}
	return dsh.Provider{}, false
}

// dshPatchModel normalizes a DSH_MODEL value (provider/model) onto the
// llm-pi-ai provider id space used by patch rendering. An already-injected id
// passes through; a bare injected name is prefixed; anything else is returned
// unchanged so RenderPatch rejects it loudly.
func dshPatchModel(model string) string {
	pid, mid, ok := strings.Cut(model, "/")
	if !ok || strings.TrimSpace(pid) == "" || strings.TrimSpace(mid) == "" {
		return strings.TrimSpace(model)
	}
	if _, ok := dsh.ProviderByID(pid); ok {
		return model
	}
	if p, ok := dsh.ProviderByID("llm-pi-ai." + pid); ok {
		return p.ID + "/" + mid
	}
	return model
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
	input := profilepkg.InputProfile{
		Name: p.Name, Client: p.Client, Provider: p.Provider,
		SecretRef: p.SecretRef, Launcher: p.Launcher,
		Env: p.Env, Settings: p.Settings,
	}
	return profilepkg.Resolve(input, reg, wiredProfileCallbacks())
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

// --- claude_app.go ---

func claudeAppCommand(args []string) int {
	defaultPort := 18080
	claudeapp.ConfigurePaths(currentForgePath, repoDir)
	deps := claudeapp.Dependencies{
		LoadManifest: func() (map[string]claudeapp.Profile, error) {
			manifest, err := loadManifest()
			if err != nil {
				return nil, err
			}
			out := make(map[string]claudeapp.Profile, len(manifest.Profiles))
			for name, p := range manifest.Profiles {
				out[name] = claudeapp.ProfileFrom(p)
			}
			return out, nil
		},
		ResolveCredential: ResolveCredential,
		UserHome:          userHome,
		RepoDir:           repoDir,
		CurrentForgePath:  currentForgePath,
		ModelOverrides: func(p claudeapp.Profile) map[string]string {
			return shellpkg.ModelOverridesFromManifest(claudeapp.ProfileToManifest(p))
		},
		ModelDisplayName: providerModelDisplayName,
		ResolveProviderBinding: func(p claudeapp.Profile) (claudeapp.ProviderBinding, error) {
			_, provider, err := catalogRegistryOrDefault().ResolveBinding(p.Client, p.Provider)
			if err != nil {
				return claudeapp.ProviderBinding{}, fmt.Errorf("forge app: profile %s has invalid client/provider binding: %v", p.Name, err)
			}
			if provider.Inference == nil {
				return claudeapp.ProviderBinding{}, nil
			}
			return claudeapp.ProviderBinding{
				Protocol:     provider.Inference.Protocol,
				Endpoint:     provider.Inference.Endpoint,
				DefaultModel: provider.DefaultModel,
			}, nil
		},
		DefaultPort: defaultPort,
	}
	return claudeapp.Command(args, deps)
}

func providerModelDisplayName(providerID, modelID string) string {
	model, ok := catalogRegistryOrDefault().ProviderModels(providerID)[modelID]
	if !ok {
		return ""
	}
	return model.DisplayName
}
