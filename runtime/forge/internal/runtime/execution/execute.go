package execution

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/driver"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/profile"
)

// planInput is the internal normalized input to buildPlan.
type planInput struct {
	Profile        string
	Prompt         string
	CWD            string
	Clean          bool
	Permission     string
	Capabilities   []string
	MCPHTTPHeaders map[string]map[string]string
}

// Prepare runs the client/MCP/profile.Resolve/driver pipeline and
// returns the resolved driver.CommandPlan plus the client family. It is the
// single request-to-plan mapping point: the root CLI and Execute both delegate
// here so the gate/buildPlan ordering is never duplicated. An empty Permission
// defaults to edit.
func Prepare(req Request, deps Dependencies) (driver.CommandPlan, string, error) {
	permission := string(req.Permission)
	if strings.TrimSpace(permission) == "" {
		permission = string(catalog.PermissionEdit)
	}
	input := planInput{
		Profile:      req.ProfileName,
		Prompt:       req.Prompt,
		CWD:          req.WorkDir,
		Clean:        req.Clean,
		Permission:   permission,
		Capabilities: append([]string(nil), req.Capabilities...),
	}
	if len(req.MCPHTTPHeaders) > 0 {
		input.MCPHTTPHeaders = make(map[string]map[string]string, len(req.MCPHTTPHeaders))
		for name, hdrs := range req.MCPHTTPHeaders {
			hdrsCopy := make(map[string]string, len(hdrs))
			for k, v := range hdrs {
				hdrsCopy[k] = v
			}
			input.MCPHTTPHeaders[name] = hdrsCopy
		}
	}
	resumeID := strings.TrimSpace(req.ResumeID)
	return buildPlan(input, resumeID, deps)
}

// buildPlan runs the client/MCP/profile.Resolve/driver pipeline with
// exact current validation/gate/error/side-effect order and text. It returns a
// driver.CommandPlan plus the resolved client family; capability injection and
// process lifecycle are handled by the caller.
func buildPlan(input planInput, resumeID string, deps Dependencies) (driver.CommandPlan, string, error) {
	profileName := strings.TrimSpace(input.Profile)
	prompt := strings.TrimSpace(input.Prompt)
	if profileName == "" {
		return driver.CommandPlan{}, "", fmt.Errorf("profile must not be empty")
	}
	if prompt == "" {
		return driver.CommandPlan{}, "", fmt.Errorf("prompt must not be empty")
	}

	def, ok, err := deps.LoadProfile(profileName)
	if err != nil {
		return driver.CommandPlan{}, "", err
	}
	if !ok {
		return driver.CommandPlan{}, "", fmt.Errorf("profile %q not found", profileName)
	}
	def.Name = profileName

	// Client gate: disabled client -> dispatch error.
	if def.Client != "" {
		if !deps.ClientEnabled(def.Client) {
			return driver.CommandPlan{}, "", fmt.Errorf("client %q disabled in config", def.Client)
		}
	}

	clientFamily := clientFamily(def)
	if clientFamily != "claude" && clientFamily != "codex" && clientFamily != "opencode" && clientFamily != "grok" && clientFamily != "dsh" {
		return driver.CommandPlan{}, "", fmt.Errorf("profile %q does not support direct runtime dispatch", profileName)
	}

	workDir, err := resolveWorkDir(input.CWD)
	if err != nil {
		return driver.CommandPlan{}, "", err
	}
	if err := rejectRemovedMCP(def); err != nil {
		return driver.CommandPlan{}, "", err
	}

	// Permission gate: parse the raw mode (default empty to edit) at the same
	// point as current execution, after workdir/MCP gates and before the
	// credential stage.
	pm, err := ParsePermissionMode(input.Permission)
	if err != nil {
		return driver.CommandPlan{}, "", err
	}

	// Credential stage: resolve the profile through the profile package at the
	// same point as current execution (after all gates and permission parsing).
	resolvedProfile, err := deps.ResolveProfile(def)
	if err != nil {
		return driver.CommandPlan{}, "", err
	}
	var runtimePreparation driver.RuntimePreparation
	if deps.PrepareRuntime != nil {
		runtimePreparation, err = deps.PrepareRuntime(def, resolvedProfile)
		if err != nil {
			return driver.CommandPlan{}, clientFamily, err
		}
	}

	// Map the already-approved client family to the catalog dialect even for
	// compatibility profiles, so the driver's sole dialect switch dispatches
	// correctly. UseCatalog is set only for clean catalog resolution.
	useCatalog := resolvedProfile.Compatibility == profile.CompatibilityNone
	var dialect catalog.Dialect
	switch clientFamily {
	case "claude":
		dialect = catalog.DialectClaudeCode
	case "codex":
		dialect = catalog.DialectCodex
	case "opencode":
		dialect = catalog.DialectOpenCode
	case "grok":
		dialect = catalog.DialectGrok
	case "dsh":
		dialect = catalog.DialectDSH
	}
	clientDesc := resolvedProfile.Client
	clientDesc.Dialect = dialect

	spec := driver.ProfileSpec{
		Name:             def.Name,
		Client:           def.Client,
		ProviderName:     def.Provider,
		Launcher:         def.Launcher,
		Env:              def.Env,
		Settings:         def.Settings,
		Supports1M:       def.Supports1M,
		UseCatalog:       useCatalog,
		ClientDesc:       clientDesc,
		Provider:         resolvedProfile.Provider,
		CredentialTarget: resolvedProfile.Credential.TargetEnv,
		CredentialValue:  resolvedProfile.Credential.Value,
		ForgeDataDir:     deps.DataDir,
		Runtime:          runtimePreparation,
	}

	plan, err := driver.BuildPlan(driver.PlanRequest{
		Spec:                spec,
		Prompt:              prompt,
		WorkDir:             workDir,
		ResumeSessionID:     strings.TrimSpace(resumeID),
		Clean:               input.Clean,
		Permission:          pm,
		Capabilities:        mergeCapabilities(def.Capabilities, input.Capabilities),
		ResolveCapabilities: deps.ResolveCapabilities,
		MCPHTTPHeaders:      input.MCPHTTPHeaders,
	})
	if err != nil {
		// If the driver returned a populated partial plan, preserve it so the
		// caller can retain Profile/ClientFamily on capability errors.
		if plan.ProfileName == "" {
			plan.ProfileName = def.Name
		}
		plan.TranscriptFamily = transcriptFamilyForClient(def)
		return plan, clientFamily, err
	}
	plan.ProfileName = def.Name
	plan.TranscriptFamily = transcriptFamilyForClient(def)
	return plan, clientFamily, nil
}

// transcriptFamilyForClient resolves the runner-only transcript normalization
// family from the native client name. Supported native families (each owning a
// dedicated transcript codec) select themselves, so codebuddy transcripts are
// normalized by the codebuddy codec while the public client family reported to
// callers remains claude. Any other client falls back to the public client
// family so unknown or legacy clients keep the shared family normalization.
func transcriptFamilyForClient(def ProfileDefinition) string {
	switch def.Client {
	case "codebuddy", "claude", "codex", "opencode", "grok", "dsh":
		return def.Client
	default:
		return clientFamily(def)
	}
}

func clientFamily(def ProfileDefinition) string {
	if def.Client == "codebuddy" {
		return "claude"
	}
	return def.Client
}

func rejectRemovedMCP(def ProfileDefinition) error {
	if def.Settings != nil {
		if raw, ok := def.Settings["mcp_servers"]; ok && raw != nil {
			return fmt.Errorf("profile %q settings.mcp_servers has been removed from Forge; use OpenCode plugins, Claude Code command-line dispatch, or direct client configuration instead", def.Name)
		}
	}
	return nil
}

func resolveWorkDir(workDir string) (string, error) {
	candidate := strings.TrimSpace(workDir)
	if candidate == "" {
		cwd, err := os.Getwd()
		if err != nil {
			return "", fmt.Errorf("resolve current work directory: %w", err)
		}
		candidate = cwd
	}
	abs, err := filepath.Abs(candidate)
	if err != nil {
		return "", fmt.Errorf("resolve work directory %q: %w", candidate, err)
	}
	info, err := os.Stat(abs)
	if err != nil {
		return "", fmt.Errorf("work directory %q is not accessible: %w", abs, err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("work directory %q is not a directory", abs)
	}
	return abs, nil
}

func ParsePermissionMode(raw string) (catalog.PermissionMode, error) {
	mode := strings.ToLower(strings.TrimSpace(raw))
	if mode == "" {
		return catalog.PermissionEdit, nil
	}
	switch mode {
	case "readonly":
		return catalog.PermissionReadonly, nil
	case "edit":
		return catalog.PermissionEdit, nil
	case "yolo":
		return catalog.PermissionYolo, nil
	case "full", "standard", "exec": // deprecated aliases -> yolo
		return catalog.PermissionYolo, nil
	default:
		return catalog.PermissionEdit, fmt.Errorf("unsupported permission mode %q", raw)
	}
}

// mergeCapabilities merges profile default capabilities with CLI additions.
// Profile defaults come first, CLI additions second. Duplicates are resolved
// in stable order (first seen wins).
func mergeCapabilities(profileDefaults, cliAdditions []string) []string {
	if len(profileDefaults) == 0 && len(cliAdditions) == 0 {
		return nil
	}
	seen := make(map[string]bool, len(profileDefaults)+len(cliAdditions))
	out := make([]string, 0, len(profileDefaults)+len(cliAdditions))
	for _, cap := range profileDefaults {
		if seen[cap] {
			continue
		}
		seen[cap] = true
		out = append(out, cap)
	}
	for _, cap := range cliAdditions {
		if seen[cap] {
			continue
		}
		seen[cap] = true
		out = append(out, cap)
	}
	return out
}
