package driver

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/bashgate"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

const codexMCPPolicyFile = "bashgate.policy"

// buildCodexPlan plans a Codex-family invocation from a PlanRequest using the
// existing CodexAdapter. Family selection is owned by BuildPlan.
func buildCodexPlan(req PlanRequest) (CommandPlan, error) {
	spec := req.Spec
	capabilityResult, err := resolveCodexCapabilities(req.Capabilities, req.ResolveCapabilities)
	if err != nil {
		return CommandPlan{ProfileName: spec.Name, Dialect: catalog.DialectCodex, WorkDir: req.WorkDir, Permission: req.Permission}, err
	}

	adapter := CodexAdapter{
		Model:           strings.TrimSpace(spec.Env["CODEX_MODEL"]),
		ReasoningEffort: strings.TrimSpace(spec.Env["CODEX_REASONING_EFFORT"]),
		Sandbox:         codexSandboxMode(spec),
	}
	opts := CommandOptions{Clean: req.Clean, Permission: req.Permission}

	var cmdArgs []string
	var stdin io.Reader
	if req.ResumeSessionID == "" {
		cmd := adapter.BuildRunCommand(spec.Name, req.Prompt, req.WorkDir, opts)
		cmdArgs = cmd.Args
		stdin = cmd.Stdin
	} else {
		cmd := adapter.BuildResumeCommand(spec.Name, req.ResumeSessionID, req.Prompt, req.WorkDir, opts)
		cmdArgs = cmd.Args
		stdin = cmd.Stdin
	}

	env := map[string]string{}
	for key, value := range spec.Env {
		env[key] = value
	}
	env["FORGE_PROFILE"] = spec.Name
	applyCredentialPlan(env, spec)

	plan := CommandPlan{
		ProfileName: spec.Name,
		Dialect:     catalog.DialectCodex,
		Command:     cmdArgs,
		Env:         env,
		Stdin:       stdin,
		WorkDir:     req.WorkDir,
		Permission:  req.Permission,
	}

	plan.Command = insertBeforeCodexPromptMarker(plan.Command, buildCodexCapabilityArgs(capabilityResult.Tools.MCP))
	if req.Permission != catalog.PermissionYolo {
		plan, err = configureCodexRestrictedBash(plan, spec, capabilityResult.BashGate.Cap)
		if err != nil {
			return plan, err
		}
	}
	return plan, nil
}

func resolveCodexCapabilities(names []string, resolve CapabilityResolver) (CapabilityResult, error) {
	if len(names) == 0 {
		return CapabilityResult{}, nil
	}
	result, err := resolveCapabilityResult(names, resolve)
	if err != nil {
		return CapabilityResult{}, err
	}
	if len(result.Tools.Cap) > 0 {
		return CapabilityResult{}, fmt.Errorf("client family %q cannot safely encode capability tool permissions", "codex")
	}
	for _, server := range result.Tools.MCP {
		if strings.EqualFold(strings.TrimSpace(server.Name), CodexMCPServerName) {
			return CapabilityResult{}, fmt.Errorf("capability MCP server name %q is reserved by Forge", server.Name)
		}
	}
	return result, nil
}

func configureCodexRestrictedBash(plan CommandPlan, spec ProfileSpec, capBash []catalog.BashRule) (CommandPlan, error) {
	policy := catalog.PolicyFor(plan.Permission)
	effectiveBashAllow, err := catalog.EffectiveBashAllow(policy, capBash)
	if err != nil {
		return plan, err
	}
	sensitivePaths, err := runtimeSensitivePaths(spec.Runtime, "")
	if err != nil {
		return plan, err
	}
	dialect, ok := codexMCPShellDialect(runtime.GOOS)
	if !ok {
		return plan, fmt.Errorf("Codex restricted Bash has no supported shell dialect for %q", runtime.GOOS)
	}
	encodedPolicy, err := bashgate.EncodePolicyForShell(
		bashgate.ClientCodex,
		effectiveBashAllow,
		spec.Runtime.SensitiveEnvKeys,
		sensitivePaths,
		dialect,
	)
	if err != nil {
		return plan, err
	}
	forgeDataDir := strings.TrimSpace(spec.ForgeDataDir)
	if forgeDataDir == "" {
		return plan, fmt.Errorf("Codex restricted Bash runtime data directory is not configured")
	}
	configParent := filepath.Join(forgeDataDir, "codex", "direct-runs")
	configHome, err := materializeRuntimePreparation(RuntimePreparation{
		HomeParent: configParent,
		Files: []PreparedFile{{
			RelativePath: codexMCPPolicyFile,
			Data:         append([]byte(encodedPolicy), '\n'),
			Mode:         0o600,
		}},
	})
	if err != nil {
		return plan, err
	}
	resource := ExecutionResource{Path: configHome, OwnershipRoot: configParent, RemoveOnSuccess: true}
	plan.Resources = append(plan.Resources, resource)
	plan.ConfigDir = configHome

	executable, err := os.Executable()
	if err != nil {
		return plan, fmt.Errorf("resolve Forge executable for Codex restricted Bash: %w", err)
	}
	policyPath := filepath.Join(configHome, codexMCPPolicyFile)
	prefix := "mcp_servers." + CodexMCPServerName
	registration := []string{
		"-c", prefix + ".command=" + tomlLiteral(executable),
		"-c", prefix + ".args=" + tomlArrayLiteral([]string{CodexMCPSubcommand, "--policy", policyPath}),
		"-c", prefix + ".cwd=" + tomlLiteral(plan.WorkDir),
		"-c", prefix + ".required=true",
		"-c", prefix + ".enabled_tools=" + tomlArrayLiteral([]string{CodexMCPToolName}),
		"-c", prefix + ".default_tools_approval_mode=\"approve\"",
	}
	plan.Command = insertBeforeCodexPromptMarker(plan.Command, registration)
	return plan, nil
}

func codexMCPShellDialect(goos string) (catalog.BashShellDialect, bool) {
	if strings.EqualFold(strings.TrimSpace(goos), "windows") {
		return catalog.BashShellPowerShell, true
	}
	return catalog.BashShellDialectForPlatform(goos)
}
