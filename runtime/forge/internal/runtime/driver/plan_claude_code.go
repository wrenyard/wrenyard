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

// buildClaudeCodePlan plans a Claude-Code-family invocation from a PlanRequest.
// Family selection is owned by BuildPlan; this planner only assembles the
// command/env/stdin for the claude-code dialect.
func buildClaudeCodePlan(req PlanRequest) (CommandPlan, error) {
	spec := req.Spec

	// Side-effect order: persist the prior CodeBuddy persistent config
	// (created inside buildClaudeCodeEnv when ConfigIsolation.PersistentDir is
	// set), then create the common claude/direct-cc config/jobs dirs, and only
	// then resolve the binary/model/command so binary resolution failures occur
	// after both directory sets already exist.
	env, configDir, err := buildClaudeCodeEnv(req)
	if err != nil {
		return CommandPlan{}, err
	}

	if err := ensureCCDirs(spec.ForgeDataDir); err != nil {
		return CommandPlan{}, err
	}

	var command []string
	var stdin io.Reader
	// Decouple catalog classification from command source: a clean catalog
	// resolution only drives the registry Client binary command when the
	// resolved Provider declares UsesClientBinary(). Launcher-backed cc-family
	// profiles (ccc/ccg) resolve in the catalog but must keep their profile
	// launcher and avoid implicit --model injection.
	if spec.UseCatalog && spec.Provider.UsesClientBinary() {
		command, stdin, err = buildClaudeCodeFromRegistry(req)
	} else {
		command, stdin, err = buildClaudeCodeLegacy(req)
	}
	if err != nil {
		return CommandPlan{}, err
	}

	plan := CommandPlan{
		ProfileName: spec.Name,
		Dialect:     catalog.DialectClaudeCode,
		Command:     command,
		Env:         env,
		Stdin:       stdin,
		WorkDir:     req.WorkDir,
		ConfigDir:   configDir,
		Permission:  req.Permission,
	}

	// Finalize capability injection immediately before the terminal -p prompt
	// flag after all directory, env, and command side effects. On a capability
	// error return the populated partial plan plus the unchanged error.
	var capErr error
	var capabilityResult CapabilityResult
	plan, capabilityResult, capErr = finalizeClaudeCapabilities(plan, spec.ClientDesc.PermissionAdapter, req.Capabilities, req.ResolveCapabilities)
	if capErr != nil {
		return plan, capErr
	}
	plan, capErr = configureClaudeFamilyBashGate(plan, spec.ClientDesc.PermissionAdapter, capabilityResult.BashGate.Cap)
	if capErr != nil {
		return plan, capErr
	}
	return plan, nil
}

// buildClaudeCodeFromRegistry uses the resolved catalog descriptor/binding for
// clean catalog profiles.
func buildClaudeCodeFromRegistry(req PlanRequest) ([]string, io.Reader, error) {
	spec := req.Spec
	desc := spec.ClientDesc
	binding := spec.Provider

	binaryCmd, err := ResolveBinary(desc.Binary)
	if err != nil {
		return nil, nil, err
	}
	command := binaryCmd

	defaultArgs := stringSliceField(spec.Launcher, "default_args", nil)
	command = append(command, defaultArgs...)

	if !hasFlag(command, "--model") {
		model := registryClaudeDefaultModel(spec, binding)
		if model != "" {
			command = append(command, "--model", model)
		}
	}

	model := modelFromArgs(command)
	if model != "" {
		if err := binding.ValidateModel(model); err != nil {
			return nil, nil, err
		}
	}

	if strings.TrimSpace(req.ResumeSessionID) != "" {
		command = append(command, desc.ResumeFlag, req.ResumeSessionID)
	}

	settingsJSON, err := claudeFamilyInlineSettings(spec, req.Permission)
	if err != nil {
		return nil, nil, err
	}
	if settingsJSON != "" {
		command = append(command, "--settings", settingsJSON)
	}

	command = appendClaudeCodeOptions(command, req, desc)

	var stdin io.Reader
	command, stdin = appendClaudePromptArgs(command, req.Prompt)

	return command, stdin, nil
}

// buildClaudeCodeLegacy builds for compatibility profiles (ccg, ccds, ccc,
// etc.) that did not resolve cleanly through the current catalog.
func buildClaudeCodeLegacy(req PlanRequest) ([]string, io.Reader, error) {
	spec := req.Spec

	command := splitCommand(stringField(spec.Launcher, "command", defaultCommand(spec)))
	if len(command) == 0 {
		command = []string{defaultCommand(spec)}
	}
	command = append(command, stringSliceField(spec.Launcher, "default_args", nil)...)
	command = appendClaudeResumeArgs(command, req.ResumeSessionID)
	settingsJSON, err := claudeFamilyInlineSettings(spec, req.Permission)
	if err != nil {
		return nil, nil, err
	}
	if settingsJSON != "" {
		command = append(command, "--settings", settingsJSON)
	}

	// Legacy path still uses a descriptor for dialect flags when available.
	desc, descErr := catalog.DefaultRegistry().LookupDescriptor(spec.Client)
	if descErr == nil {
		var stdin io.Reader
		command = appendClaudeCodeOptions(command, req, desc)
		command, stdin = appendClaudePromptArgs(command, req.Prompt)
		return command, stdin, nil
	}

	var stdin io.Reader
	command = appendClaudeCodeOptions(command, req, catalog.Client{
		DialectFlags: catalog.DialectFlags{
			SupportsVerbose:             true,
			SupportsBare:                true,
			SupportsReplayUserMessages:  true,
			SupportsDevelopmentChannels: true,
		},
	})
	command, stdin = appendClaudePromptArgs(command, req.Prompt)
	return command, stdin, nil
}

func configureClaudeFamilyBashGate(plan CommandPlan, adapter catalog.PermissionAdapter, capBash []catalog.BashRule) (CommandPlan, error) {
	policy := catalog.PolicyFor(plan.Permission)
	if policy.BashUnrestricted {
		return plan, nil
	}
	allow, err := catalog.EffectiveBashAllow(policy, capBash)
	if err != nil {
		return plan, err
	}
	client := bashgate.ClientClaude
	if adapter == catalog.PermissionAdapterCodeBuddy {
		client = bashgate.ClientCodeBuddy
	} else if adapter != "" && adapter != catalog.PermissionAdapterClaude {
		return plan, fmt.Errorf("unsupported Claude-family BashGate adapter %q", adapter)
	}
	encoded, err := bashgate.EncodePolicyForPlatform(client, allow, nil, nil, runtime.GOOS)
	if err != nil {
		return plan, err
	}
	if plan.Env == nil {
		plan.Env = map[string]string{}
	}
	if runtime.GOOS == "windows" {
		executable, executableErr := os.Executable()
		if executableErr != nil {
			return plan, fmt.Errorf("resolve Forge executable for Claude-family BashGate: %w", executableErr)
		}
		hookEnv, hookEnvErr := bashgate.ClaudeFamilyHookEnv(executable)
		if hookEnvErr != nil {
			return plan, hookEnvErr
		}
		for key, value := range hookEnv {
			plan.Env[key] = value
		}
	}
	plan.Env[bashgate.ModeEnv] = string(client)
	plan.Env[bashgate.PolicyEnv] = encoded
	return plan, nil
}

func registryClaudeDefaultModel(spec ProfileSpec, binding catalog.Provider) string {
	if model := strings.TrimSpace(spec.Env["ANTHROPIC_MODEL"]); model != "" {
		return model
	}
	if len(binding.AllowedModels) == 1 {
		return binding.AllowedModels[0]
	}
	return claudeDefaultModel(spec)
}

// buildClaudeCodeEnv builds the isolated environment. For catalog profiles it
// uses descriptor config isolation / hygiene / binding env; legacy paths copy
// profile env and inject FORGE_PROFILE + credential overlay.
func buildClaudeCodeEnv(req PlanRequest) (map[string]string, string, error) {
	spec := req.Spec
	env := map[string]string{}

	for key, value := range spec.Env {
		env[key] = value
	}
	env["FORGE_PROFILE"] = spec.Name
	applyCredentialPlan(env, spec)

	if spec.UseCatalog {
		desc := spec.ClientDesc

		configDir := ClaudeConfigDir(spec.ForgeDataDir)
		if desc.ConfigIsolation.EnvVar != "" {
			if desc.ConfigIsolation.PersistentDir != "" {
				configDir = filepath.Join(spec.ForgeDataDir, desc.ConfigIsolation.PersistentDir)
				if err := os.MkdirAll(configDir, 0o755); err != nil {
					return nil, "", err
				}
			}
			env[desc.ConfigIsolation.EnvVar] = configDir
		} else {
			env["CLAUDE_CONFIG_DIR"] = configDir
		}

		for _, h := range desc.Hygiene {
			if idx := strings.Index(h, "="); idx >= 0 {
				env[h[:idx]] = h[idx+1:]
			}
		}

		for k, v := range spec.Provider.Env {
			env[k] = v
		}

		env["CLAUDE_JOB_DIR"] = ClaudeJobDir(spec.ForgeDataDir)
		return env, configDir, nil
	}

	configDir := ClaudeConfigDir(spec.ForgeDataDir)
	env["CLAUDE_CONFIG_DIR"] = configDir
	env["CLAUDE_JOB_DIR"] = ClaudeJobDir(spec.ForgeDataDir)
	return env, configDir, nil
}

// applyCredentialPlan injects the resolved credential into env at the
// credential overlay stage, preserving the legacy env-order: profile env,
// FORGE_PROFILE, then credential.
func applyCredentialPlan(env map[string]string, spec ProfileSpec) {
	if spec.CredentialValue != "" {
		env[spec.CredentialTarget] = spec.CredentialValue
	}
}

func appendClaudeResumeArgs(args []string, nativeSessionID string) []string {
	if strings.TrimSpace(nativeSessionID) == "" {
		return args
	}
	return append(args, "--resume", nativeSessionID)
}

func appendClaudePromptArgs(args []string, prompt string) ([]string, io.Reader) {
	args = append(args, "-p")
	payload, err := EncodeClaudeStreamUserMessage(prompt)
	if err != nil {
		return args, strings.NewReader(prompt)
	}
	return args, strings.NewReader(string(payload))
}

func appendClaudeCodeOptions(args []string, req PlanRequest, desc catalog.Client) []string {
	opts := CommandOptions{Clean: req.Clean, Permission: req.Permission}

	if opts.Clean {
		cleanArgs := ClaudeCleanArgs()
		if !desc.DialectFlags.SupportsBare {
			cleanArgs = removeFlag(cleanArgs, "--bare")
		}
		args = append(args, cleanArgs...)
	}

	permMode := catalog.PermissionMode(opts.Permission)
	args = append(args, desc.BuildPermissionArgs(permMode)...)

	if desc.Name == "codebuddy" {
		args = appendCodeBuddyToolScopePrompt(args, permMode)
	}

	flags := desc.FilterFlags([]string{
		"--verbose",
		"--replay-user-messages",
	})
	args = append(args,
		"--input-format", "stream-json",
		"--output-format", "stream-json",
	)
	args = append(args, flags...)

	if desc.DialectFlags.SupportsDevelopmentChannels {
		args = mergeDevelopmentChannels(args)
	}

	args = mergeDisallowedToolsForMode(args, desc.PermissionAdapter, permMode)

	return args
}
