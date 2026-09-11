package forge

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/dsh"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/grok"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/lifecycle/change"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/profiles/discovery"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/profiles/selection"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/auth"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/cursor"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/capability"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/driver"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/execution"
	profilepkg "github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/profile"
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

func providersCommand(args []string) int {
	reg, err := loadCatalogRegistry()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return discovery.ProvidersCommand(wiredDiscoveryProviderDeps(reg), args)
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
		CursorModelAvailability: func() (map[string]cursor.Availability, error) {
			token, ok := authStatusCredential("cursor")
			if !ok || strings.TrimSpace(token) == "" {
				return nil, fmt.Errorf("cursor credential unavailable")
			}
			return (cursor.Reader{Token: token}).Availability()
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
			// Canonical daemon dispatch plans are the sole Go execution
			// definition source: the legacy source manifest was retired, so
			// every requested runtime resolves strictly from its dispatch plan.
			// Build a minimal definition from the already-resolved plan and the
			// registered client/provider adapters, then let ResolveProfile
			// materialize it. A missing plan or an unknown client/provider
			// stays unavailable with no fallback.
			plan, planErr := dispatchPlanForProfile(name)
			if planErr != nil {
				return execution.ProfileDefinition{}, false, nil
			}
			if _, err := catalogRegistryOrDefault().LookupDescriptor(plan.Client); err != nil {
				return execution.ProfileDefinition{}, false, nil
			}
			if _, ok := providers.Lookup(plan.Provider); !ok {
				return execution.ProfileDefinition{}, false, nil
			}
			return execution.ProfileDefinition{
				Name: name, Client: plan.Client, Provider: plan.Provider,
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
	// Native CodeBuddy plans are revalidated against the current login on
	// every admission so a stale cross-environment wire model can never run.
	if isCodeBuddyNativePlan(plan) {
		return bindCodeBuddyDispatchPlan(plan)
	}
	return plan, nil
}

// codeBuddyIOAEnvironment is the normalized observed CodeBuddy environment in
// which canonical CodeBuddy models execute under their -ioa wire identity.
const codeBuddyIOAEnvironment = "ioa"

// codeBuddyCanonicalToWireModel mirrors the TypeScript runtime mapping from
// canonical CodeBuddy models to their -ioa wire identity. It is applied only
// in the ioa environment; already-wire models and non-iOA models are never
// rewritten.
var codeBuddyCanonicalToWireModel = map[string]string{
	"deepseek-v4.1-flash": "deepseek-v4.1-flash-ioa",
	"hy4-preview":         "hy4-preview-ioa",
	"hy3":                 "hy3-ioa",
	"minimax-m3":          "minimax-m3-ioa",
}

// codeBuddyWireModel derives the wire model for a canonical CodeBuddy model
// under a normalized observed environment. Only the ioa environment remaps the
// five canonical models to their -ioa wire identity; any other environment,
// already-wire model, or non-iOA model is left unchanged.
func codeBuddyWireModel(environment, model string) string {
	if environment != codeBuddyIOAEnvironment {
		return model
	}
	if wire, ok := codeBuddyCanonicalToWireModel[model]; ok {
		return wire
	}
	return model
}

// isCodeBuddyNativePlan reports whether a plan is a native CodeBuddy execution
// plan whose client and provider both resolve through CodeBuddy.
func isCodeBuddyNativePlan(plan profilepkg.DispatchPlan) bool {
	return plan.Client == "codebuddy" && plan.Provider == "codebuddy" &&
		plan.Mode == "native"
}

// bindCodeBuddyDispatchPlan fails a native CodeBuddy dispatch plan closed
// unless the complete private expected tuple (opaque scope, normalized
// environment, and expected wire model, supplied through the Forge-private
// driver env names) matches the current login resolved independently from
// current auth/product state via CodeBuddyActiveScope. On success it returns a
// copy whose Model has been replaced in memory with the wire model derived
// from the current environment and the plan's canonical model. Errors are
// generic and never contain actual or expected scope, environment, domain,
// account, token, or wire values.
func bindCodeBuddyDispatchPlan(plan profilepkg.DispatchPlan) (profilepkg.DispatchPlan, error) {
	expectedScope := strings.TrimSpace(os.Getenv(driver.CodeBuddyExpectedScopeEnv))
	expectedEnvironment := strings.TrimSpace(os.Getenv(driver.CodeBuddyExpectedEnvironmentEnv))
	expectedWire := strings.TrimSpace(os.Getenv(driver.CodeBuddyExpectedWireModelEnv))
	if expectedScope == "" || expectedEnvironment == "" || expectedWire == "" {
		return profilepkg.DispatchPlan{}, fmt.Errorf("codebuddy dispatch plan is unavailable: login context is missing")
	}
	current := authStatusResolver().CodeBuddyActiveScope()
	if !current.OK || strings.TrimSpace(current.Scope) == "" || strings.TrimSpace(current.Environment) == "" {
		return profilepkg.DispatchPlan{}, fmt.Errorf("codebuddy dispatch plan is unavailable: current login could not be resolved")
	}
	if current.Scope != expectedScope || current.Environment != expectedEnvironment {
		return profilepkg.DispatchPlan{}, fmt.Errorf("codebuddy dispatch plan does not match the current login")
	}
	if wire := codeBuddyWireModel(current.Environment, plan.Model); wire != expectedWire {
		return profilepkg.DispatchPlan{}, fmt.Errorf("codebuddy dispatch plan does not match the current environment")
	}
	plan.Model = codeBuddyWireModel(current.Environment, plan.Model)
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
