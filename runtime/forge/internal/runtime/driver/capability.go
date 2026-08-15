package driver

import (
	"encoding/json"
	"fmt"
	"sort"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

// CapabilityServer is the driver-owned, neutral description of a single
// resolved MCP server requested through a capability pack. It carries exactly
// the fields needed to build client-specific command-line arguments; no
// root/production pack naming or dialect switching lives here. The selected
// family planner finalizes capability injection using these values.
type CapabilityServer struct {
	Name              string
	Command           string
	Args              []string
	Env               map[string]string
	URL               string
	StartupTimeoutSec int
}

// CapabilityTools is the neutral tool contribution of capability packs. Cap
// contains non-builtin tool ids and MCP contains concrete server definitions.
type CapabilityTools struct {
	Cap []string
	MCP []CapabilityServer
}

// CapabilityBashGate is the neutral Bash allow contribution of packs.
type CapabilityBashGate struct {
	Cap []catalog.BashRule
}

// CapabilityResult is intentionally client-neutral. A pack can contribute a
// tool, Bash command scope, MCP servers, or any combination without containing
// client names or argv fragments.
type CapabilityResult struct {
	Tools    CapabilityTools
	BashGate CapabilityBashGate
}

// CapabilityResolver resolves capability pack names into a neutral result.
// Adapters, not packs or the root package, own downstream encoding.
type CapabilityResolver func(names []string) (CapabilityResult, error)

// resolveCapabilityResult validates neutral capability data immediately after
// resolution and before any family-specific encoder sees it. Resolver seams
// are intentionally held to the same schema as manifest-backed production
// resolution, including in yolo mode.
func resolveCapabilityResult(names []string, resolve CapabilityResolver) (CapabilityResult, error) {
	if resolve == nil {
		return CapabilityResult{}, fmt.Errorf("capability resolver is not configured")
	}
	result, err := resolve(names)
	if err != nil {
		return CapabilityResult{}, err
	}
	if err := catalog.ValidateCapabilityBashRules(result.BashGate.Cap); err != nil {
		return CapabilityResult{}, err
	}
	return result, nil
}

// finalizeCodexCapabilities resolves the requested capability packs and injects
// them into the Codex command plan before the terminal stdin prompt marker. It
// returns the unmodified plan when no capabilities were requested. On resolver
// error it returns the populated plan unchanged plus the error so execution
// preserves the client family.
func finalizeCodexCapabilities(plan CommandPlan, names []string, resolve CapabilityResolver) (CommandPlan, error) {
	if len(names) == 0 {
		return plan, nil
	}
	result, err := resolveCapabilityResult(names, resolve)
	if err != nil {
		return plan, err
	}
	if len(result.Tools.Cap) > 0 || len(result.BashGate.Cap) > 0 {
		return plan, fmt.Errorf("client family %q cannot safely encode capability tool or Bash permissions", "codex")
	}
	plan.Command = insertBeforeCodexPromptMarker(plan.Command, buildCodexCapabilityArgs(result.Tools.MCP))
	return plan, nil
}

// finalizeClaudeCapabilities resolves the requested capability packs and
// injects them into the Claude/CodeBuddy command plan immediately before the
// terminal -p prompt flag. It returns the unmodified plan when no capabilities
// were requested. On resolver error it returns the populated plan unchanged
// plus the error so execution preserves the client family.
func finalizeClaudeCapabilities(plan CommandPlan, adapter catalog.PermissionAdapter, names []string, resolve CapabilityResolver) (CommandPlan, CapabilityResult, error) {
	if len(names) == 0 {
		return plan, CapabilityResult{}, nil
	}
	result, err := resolveCapabilityResult(names, resolve)
	if err != nil {
		return plan, CapabilityResult{}, err
	}
	externalTools, err := catalog.EncodeExternalCapabilityToolIDs(adapter, result.Tools.Cap)
	if err != nil {
		return plan, result, err
	}
	if plan.Permission != catalog.PermissionYolo {
		var composeErr error
		plan.Command, composeErr = composeClaudeCapabilityPermission(plan.Command, adapter, externalTools, result.BashGate.Cap)
		if composeErr != nil {
			return plan, result, composeErr
		}
		if adapter == catalog.PermissionAdapterCodeBuddy {
			plan.Command = refreshCodeBuddyToolScopePrompt(plan.Command, plan.Permission)
		}
	}
	plan.Command = insertBeforeClaudePromptFlag(plan.Command, buildClaudeCapabilityArgs(plan.Command, result.Tools.MCP))
	return plan, result, nil
}

// composeClaudeCapabilityPermission augments the native permission fields in
// place. It does not search for a pristine base argv sequence, so independently
// merged orchestration denials remain untouched and in their established order.
func composeClaudeCapabilityPermission(args []string, adapter catalog.PermissionAdapter, tools []string, bashRules []catalog.BashRule) ([]string, error) {
	if len(tools) > 0 {
		var found bool
		args, found = appendClaudeCapabilityTools(args, tools)
		if !found {
			return args, fmt.Errorf("client family %q permission tool field was not found for capability encoding", adapter)
		}
	}
	if len(bashRules) == 0 {
		return args, nil
	}

	disallowed := -1
	allowed := -1
	for i, arg := range args {
		switch {
		case arg == "--allowedTools" || arg == "--allowed-tools" || len(arg) > len("--allowedTools=") && arg[:len("--allowedTools=")] == "--allowedTools=":
			allowed = i
		case arg == "--disallowedTools" || arg == "--disallowed-tools" || len(arg) > len("--disallowedTools=") && arg[:len("--disallowedTools=")] == "--disallowedTools=":
			disallowed = i
		}
	}
	if allowed < 0 || disallowed < 0 || allowed >= disallowed {
		return args, fmt.Errorf("client family %q permission Bash fields were not found for capability encoding", adapter)
	}

	existing := make(map[string]bool, disallowed-allowed)
	for _, arg := range args[allowed+1 : disallowed] {
		existing[arg] = true
	}
	inject := make([]string, 0, len(bashRules))
	for _, rule := range bashRules {
		encoded := catalog.EncodeBashRule(rule)
		if !existing[encoded] {
			existing[encoded] = true
			inject = append(inject, encoded)
		}
	}
	return insertArgsAt(args, disallowed, inject), nil
}

func appendClaudeCapabilityTools(args, tools []string) ([]string, bool) {
	flagIndex := -1
	valueIndex := -1
	equalsForm := false
	for i, arg := range args {
		if len(arg) >= len("--tools=") && arg[:len("--tools=")] == "--tools=" {
			flagIndex = i
			valueIndex = i
			equalsForm = true
			continue
		}
		if arg == "--tools" && i+1 < len(args) {
			flagIndex = i
			valueIndex = i + 1
			equalsForm = false
		}
	}
	if flagIndex < 0 {
		return args, false
	}
	value := args[valueIndex]
	if equalsForm {
		value = value[len("--tools="):]
	}
	seen := map[string]bool{}
	for _, existing := range splitCommaList(value) {
		seen[existing] = true
	}
	for _, tool := range tools {
		if seen[tool] {
			continue
		}
		seen[tool] = true
		if value == "" {
			value = tool
		} else {
			value += "," + tool
		}
	}
	if equalsForm {
		args[valueIndex] = "--tools=" + value
	} else {
		args[valueIndex] = value
	}
	return args, true
}

// buildCodexCapabilityArgs builds the exact Codex -c mcp_servers.* arguments,
// preserving the TOML literal semantics moved from the root capabilities file.
func buildCodexCapabilityArgs(servers []CapabilityServer) []string {
	var args []string
	for _, server := range servers {
		prefix := "mcp_servers." + server.Name
		if server.URL != "" {
			args = append(args, "-c", prefix+".url="+tomlLiteral(server.URL))
			continue
		}

		args = append(args, "-c", prefix+".command="+tomlLiteral(server.Command))
		args = append(args, "-c", prefix+".args="+tomlArrayLiteral(server.Args))
		if server.StartupTimeoutSec > 0 {
			args = append(args, "-c", prefix+".startup_timeout_sec="+fmt.Sprint(server.StartupTimeoutSec))
		}

		envKeys := sortedCapabilityEnvKeys(server.Env)
		for _, key := range envKeys {
			args = append(args, "-c", prefix+".env."+key+"="+tomlLiteral(server.Env[key]))
		}
	}
	return args
}

// buildClaudeCapabilityArgs builds the exact Claude --strict-mcp-config and
// --mcp-config JSON arguments, preserving the semantics moved from the root
// capabilities file.
func buildClaudeCapabilityArgs(existing []string, servers []CapabilityServer) []string {
	type claudeServer struct {
		Type    string            `json:"type,omitempty"`
		URL     string            `json:"url,omitempty"`
		Command string            `json:"command,omitempty"`
		Args    []string          `json:"args,omitempty"`
		Env     map[string]string `json:"env,omitempty"`
	}

	payload := struct {
		MCPServers map[string]claudeServer `json:"mcpServers"`
	}{MCPServers: map[string]claudeServer{}}

	for _, server := range servers {
		if server.URL != "" {
			payload.MCPServers[server.Name] = claudeServer{Type: "http", URL: server.URL}
			continue
		}
		payload.MCPServers[server.Name] = claudeServer{
			Command: server.Command,
			Args:    append([]string(nil), server.Args...),
			Env:     copyCapabilityEnv(server.Env),
		}
	}

	data, _ := json.Marshal(payload)
	args := []string{}
	if !hasFlag(existing, "--strict-mcp-config") {
		args = append(args, "--strict-mcp-config")
	}
	args = append(args, "--mcp-config", string(data))
	return args
}

// insertBeforeCodexPromptMarker inserts inject immediately before the terminal
// stdin prompt marker "-", preserving its trailing position.
func insertBeforeCodexPromptMarker(args, inject []string) []string {
	if len(inject) == 0 {
		return args
	}
	idx := len(args)
	if len(args) > 0 && args[len(args)-1] == "-" {
		idx = len(args) - 1
	}
	return insertArgsAt(args, idx, inject)
}

// insertBeforeClaudePromptFlag inserts inject immediately before the terminal
// -p prompt flag, preserving its trailing position.
func insertBeforeClaudePromptFlag(args, inject []string) []string {
	if len(inject) == 0 {
		return args
	}
	idx := len(args)
	if len(args) > 0 && args[len(args)-1] == "-p" {
		idx = len(args) - 1
	}
	return insertArgsAt(args, idx, inject)
}

func insertArgsAt(args []string, idx int, inject []string) []string {
	out := make([]string, 0, len(args)+len(inject))
	out = append(out, args[:idx]...)
	out = append(out, inject...)
	out = append(out, args[idx:]...)
	return out
}

func tomlLiteral(value string) string {
	data, _ := json.Marshal(value)
	return string(data)
}

func tomlArrayLiteral(values []string) string {
	data, _ := json.Marshal(values)
	return string(data)
}

func sortedCapabilityEnvKeys(m map[string]string) []string {
	if len(m) == 0 {
		return nil
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func copyCapabilityEnv(in map[string]string) map[string]string {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}
