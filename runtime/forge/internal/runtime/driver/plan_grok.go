package driver

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/grok"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/bashgate"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

func buildGrokPlan(req PlanRequest) (CommandPlan, error) {
	spec := req.Spec
	home, err := materializeRuntimePreparation(spec.Runtime)
	if err != nil {
		return CommandPlan{}, err
	}
	resource := ExecutionResource{Path: home, OwnershipRoot: spec.Runtime.HomeParent, RemoveOnSuccess: true}
	resumeID := strings.TrimSpace(req.ResumeSessionID)
	if resumeID != "" {
		if err := grok.RestoreNativeSessionSnapshot(spec.ForgeDataDir, home, resumeID); err != nil {
			return CommandPlan{Resources: []ExecutionResource{resource}, ConfigDir: home}, err
		}
	}
	promptPath := filepath.Join(home, "prompt.txt")
	promptBytes := []byte(strings.ToValidUTF8(req.Prompt, "\uFFFD"))
	if err := os.WriteFile(promptPath, promptBytes, 0o600); err != nil {
		return CommandPlan{Resources: []ExecutionResource{resource}, ConfigDir: home}, fmt.Errorf("write Grok prompt file: %w", err)
	}

	binary, err := ResolveBinary(spec.ClientDesc.Binary)
	if err != nil {
		return CommandPlan{Resources: []ExecutionResource{resource}, ConfigDir: home}, err
	}

	capabilityResult := CapabilityResult{}
	httpMCPServers := make([]CapabilityServer, 0)
	if len(req.Capabilities) > 0 {
		capabilityResult, err = resolveCapabilityResult(req.Capabilities, req.ResolveCapabilities)
		if err != nil {
			return CommandPlan{Resources: []ExecutionResource{resource}, ConfigDir: home}, err
		}
		// Filter for HTTP URL MCP servers; reject non-HTTP (stdio/SSE) servers
		// and URLs without http or https scheme.
		for _, server := range capabilityResult.Tools.MCP {
			if server.URL == "" {
				return CommandPlan{Resources: []ExecutionResource{resource}, ConfigDir: home}, fmt.Errorf("profile %q uses client family %q, which only supports HTTP MCP servers; server %q has no URL", spec.Name, "grok", server.Name)
			}
			if !strings.HasPrefix(server.URL, "http://") && !strings.HasPrefix(server.URL, "https://") {
				return CommandPlan{Resources: []ExecutionResource{resource}, ConfigDir: home}, fmt.Errorf("profile %q uses client family %q, which only supports HTTP MCP servers; server %q has unsupported URL scheme", spec.Name, "grok", server.Name)
			}
			httpMCPServers = append(httpMCPServers, server)
		}
	}

	// Apply FORGE_MCP_HTTP_HEADERS_JSON only to matching HTTP MCP server names.
	if len(req.MCPHTTPHeaders) > 0 {
		// Reject unknown server keys in the header map.
		serverNames := make(map[string]bool, len(httpMCPServers))
		for _, s := range httpMCPServers {
			serverNames[s.Name] = true
		}
		for serverName := range req.MCPHTTPHeaders {
			if !serverNames[serverName] {
				return CommandPlan{Resources: []ExecutionResource{resource}, ConfigDir: home}, fmt.Errorf("profile %q: FORGE_MCP_HTTP_HEADERS_JSON references unknown server %q", spec.Name, serverName)
			}
		}
	}

	policy := catalog.PolicyFor(req.Permission)
	permissionArgs, err := catalog.EncodeGrokPermissionArgs(
		policy,
		capabilityResult.Tools.Cap,
		capabilityResult.BashGate.Cap,
		runtime.GOOS,
	)
	if err != nil {
		return CommandPlan{Resources: []ExecutionResource{resource}, ConfigDir: home}, err
	}
	{
		effectiveBashAllow, err := catalog.EffectiveBashAllow(policy, capabilityResult.BashGate.Cap)
		if err != nil {
			return CommandPlan{Resources: []ExecutionResource{resource}, ConfigDir: home}, err
		}
		sensitivePaths, err := runtimeSensitivePaths(spec.Runtime, home)
		if err != nil {
			return CommandPlan{Resources: []ExecutionResource{resource}, ConfigDir: home}, err
		}
		if err := materializeGrokBashGuard(home, effectiveBashAllow, spec.Runtime.SensitiveEnvKeys, sensitivePaths, policy.BashUnrestricted); err != nil {
			return CommandPlan{Resources: []ExecutionResource{resource}, ConfigDir: home}, err
		}
	}

	// Materialize MCP server entries into config.toml.
	if len(httpMCPServers) > 0 {
		configPath := filepath.Join(home, "config.toml")
		existing, err := os.ReadFile(configPath)
		if err != nil && !os.IsNotExist(err) {
			return CommandPlan{Resources: []ExecutionResource{resource}, ConfigDir: home}, fmt.Errorf("read Grok config for MCP materialization: %w", err)
		}
		mcpConfigs := make([]grok.MCPServerConfig, 0, len(httpMCPServers))
		for _, server := range httpMCPServers {
			mcpConfigs = append(mcpConfigs, grok.MCPServerConfig{
				Name:    server.Name,
				URL:     server.URL,
				Headers: req.MCPHTTPHeaders[server.Name],
			})
		}
		mcpData, err := grok.MCPConfigBytes(mcpConfigs)
		if err != nil {
			return CommandPlan{Resources: []ExecutionResource{resource}, ConfigDir: home}, fmt.Errorf("profile %q: %w", spec.Name, err)
		}
		combined := append(existing, mcpData...)
		if err := os.WriteFile(configPath, combined, 0o600); err != nil {
			return CommandPlan{Resources: []ExecutionResource{resource}, ConfigDir: home}, fmt.Errorf("write Grok config with MCP servers: %w", err)
		}
	}

	// Build MCP permission allowlist for headless Grok: each resolved HTTP MCP
	// server gets a narrow --allow MCPTool(name__*) pair so the Grok process
	// can execute MCP tools without interactive approval while every other
	// capability remains governed by the Sandbox/mode permission boundary.
	mcpPermissionArgs, err := buildGrokMCPPermissionArgs(httpMCPServers)
	if err != nil {
		return CommandPlan{Resources: []ExecutionResource{resource}, ConfigDir: home}, fmt.Errorf("profile %q: %w", spec.Name, err)
	}

	command := append([]string(nil), binary...)
	command = append(command, permissionArgs...)
	command = append(command, mcpPermissionArgs...)
	model := strings.TrimSpace(spec.Env["GROK_MODEL"])
	if model == "" {
		return CommandPlan{Resources: []ExecutionResource{resource}, ConfigDir: home}, fmt.Errorf("profile %q has no Grok wire model", spec.Name)
	}
	command = append(command, "--model", model)
	if resumeID != "" {
		command = append(command, spec.ClientDesc.ResumeFlag, resumeID)
	}
	command = append(command, "--output-format", "streaming-json", "--prompt-file", promptPath)

	env := map[string]string{"FORGE_PROFILE": spec.Name}
	for key, value := range spec.Runtime.Env {
		env[key] = value
	}
	env[spec.Runtime.HomeEnvVar] = home

	return CommandPlan{
		ProfileName: spec.Name,
		Dialect:     catalog.DialectGrok,
		Command:     command,
		Env:         env,
		WorkDir:     req.WorkDir,
		ConfigDir:   home,
		Permission:  req.Permission,
		Resources:   []ExecutionResource{resource},
	}, nil
}

func buildGrokMCPPermissionArgs(servers []CapabilityServer) ([]string, error) {
	if len(servers) == 0 {
		return nil, nil
	}
	// Collect and deduplicate server names.
	seen := make(map[string]bool, len(servers))
	names := make([]string, 0, len(servers))
	for _, s := range servers {
		if seen[s.Name] {
			continue
		}
		seen[s.Name] = true
		if s.Name == "" {
			return nil, fmt.Errorf("MCP server name is empty")
		}
		// Validate the server name only contains safe characters so
		// MCPTool(name__*) can be reliably parsed by Grok.
		for _, r := range s.Name {
			if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.') {
				return nil, fmt.Errorf("MCP server name %q contains unsafe character %q for Grok MCPTool rule encoding", s.Name, r)
			}
		}
		names = append(names, s.Name)
	}
	sort.Strings(names)

	args := make([]string, 0, len(names)*2)
	for _, name := range names {
		args = append(args, "--allow", "MCPTool("+name+"__*)")
	}
	return args, nil
}

func runtimeSensitivePaths(prep RuntimePreparation, home string) ([]bashgate.SensitivePath, error) {
	candidates := make([]string, 0, len(prep.SensitiveSources)+len(prep.Copies)*2)
	for _, source := range prep.SensitiveSources {
		candidates = append(candidates, source.Path)
	}
	for _, copySpec := range prep.Copies {
		if !copySpec.Sensitive {
			continue
		}
		candidates = append(candidates, copySpec.SourcePath)
		destination, err := preparedTarget(home, copySpec.RelativePath)
		if err != nil {
			return nil, err
		}
		candidates = append(candidates, destination)
	}

	paths := make([]bashgate.SensitivePath, 0, len(candidates))
	infos := make([]os.FileInfo, 0, len(candidates))
	for _, raw := range candidates {
		trimmed := strings.TrimSpace(raw)
		absolute, err := filepath.Abs(trimmed)
		if err != nil || trimmed == "" {
			return nil, fmt.Errorf("resolve sensitive credential source")
		}
		absolute = filepath.Clean(absolute)
		info, err := os.Stat(absolute)
		if err != nil || !info.Mode().IsRegular() {
			return nil, fmt.Errorf("resolve sensitive credential source")
		}
		canonical := absolute
		if resolved, err := filepath.EvalSymlinks(absolute); err == nil {
			canonical = filepath.Clean(resolved)
		}
		duplicate := false
		for index, path := range paths {
			if sameRuntimePath(path.Path, canonical) || os.SameFile(infos[index], info) {
				duplicate = true
				break
			}
		}
		if duplicate {
			continue
		}
		paths = append(paths, bashgate.SensitivePath{Path: canonical, DenyContainingDirEnumeration: true})
		infos = append(infos, info)
	}
	return paths, nil
}

func sameRuntimePath(left, right string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(filepath.Clean(left), filepath.Clean(right))
	}
	return filepath.Clean(left) == filepath.Clean(right)
}

func materializeGrokBashGuard(home string, effectiveBashAllow []catalog.BashRule, sensitiveEnvKeys []string, sensitivePaths []bashgate.SensitivePath, bashUnrestricted bool) error {
	executable, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve Forge executable for Grok Bash guard: %w", err)
	}
	hookData, err := grok.BashGateHookBytesForMode(executable, effectiveBashAllow, sensitiveEnvKeys, sensitivePaths, runtime.GOOS, bashUnrestricted)
	if err != nil {
		return err
	}
	hookPath, err := preparedTarget(home, filepath.Join("hooks", "forge-bash-guard.json"))
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(hookPath), 0o700); err != nil {
		return fmt.Errorf("create Grok Bash guard hook directory: %w", err)
	}
	if err := os.WriteFile(hookPath, hookData, 0o600); err != nil {
		return fmt.Errorf("write Grok Bash guard hook: %w", err)
	}
	return nil
}
