// Package bashgate owns Forge's fail-closed runtime enforcement for restricted
// native clients whose native Bash allow rules match whole command strings.
package bashgate

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"os"
	"regexp"
	"runtime"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

const (
	ModeEnv   = "FORGE_INTERNAL_BASH_GATE_CLIENT"
	PolicyEnv = "FORGE_INTERNAL_BASH_GATE_POLICY"

	maxPayloadBytes = 1 << 20
)

type Client string

const (
	ClientGrok      Client = "grok"
	ClientClaude    Client = "claude"
	ClientCodeBuddy Client = "codebuddy"
	ClientOpenCode  Client = "opencode"
	ClientCodex     Client = "codex"
)

type encodedPolicy struct {
	Version                  int                      `json:"version"`
	Client                   Client                   `json:"client"`
	BashAllow                []string                 `json:"bash_allow"`
	BashUnrestricted         bool                     `json:"bash_unrestricted,omitempty"`
	SensitiveEnvKeys         []string                 `json:"sensitive_env_keys,omitempty"`
	SensitiveFilesystemPaths []SensitivePath          `json:"sensitive_filesystem_paths,omitempty"`
	ShellDialect             catalog.BashShellDialect `json:"shell_dialect"`
}

// SensitivePath is secret-free policy metadata for one credential file. The
// containing-directory flag protects native listing tools without denying
// unrelated files elsewhere in the same user tree.
type SensitivePath struct {
	Path                         string `json:"path"`
	DenyContainingDirEnumeration bool   `json:"deny_containing_directory_enumeration"`
}

type toolRequest struct {
	name  string
	input map[string]any
	cwd   string
}

var (
	processEnvironmentPath = regexp.MustCompile(`(?i)(^|/)proc/(self|thread-self|[0-9]+)(/task/(self|thread-self|[0-9]+))?/environ($|/)`)
	processDirectoryPath   = regexp.MustCompile(`(?i)(^|/)proc(?:/(self|thread-self|[0-9]+)(?:/task/(self|thread-self|[0-9]+))?)?/?$`)
	environmentCommand     = regexp.MustCompile(`(?i)(^|[;&|\r\n])\s*(?:/usr/bin/|/bin/)?(?:env|printenv|set|export)(?:\s|$)`)
)

// EncodePolicy serializes only secret-free policy data for one per-run hook.
func EncodePolicy(client Client, allow []catalog.BashRule, sensitiveEnvKeys []string, sensitivePaths []SensitivePath) (string, error) {
	return EncodePolicyForPlatform(client, allow, sensitiveEnvKeys, sensitivePaths, runtime.GOOS)
}

// EncodePolicyForPlatform records the child shell contract in the policy so
// authorization does not accidentally use the Forge host's case semantics.
func EncodePolicyForPlatform(client Client, allow []catalog.BashRule, sensitiveEnvKeys []string, sensitivePaths []SensitivePath, goos string) (string, error) {
	dialect, ok := catalog.BashShellDialectForPlatform(goos)
	if !ok {
		return "", policyError{}
	}
	return EncodePolicyForShell(client, allow, sensitiveEnvKeys, sensitivePaths, dialect)
}

// EncodePolicyForShell is the explicit payload boundary for clients whose
// verified child shell dialect is known independently of the host platform.
func EncodePolicyForShell(client Client, allow []catalog.BashRule, sensitiveEnvKeys []string, sensitivePaths []SensitivePath, dialect catalog.BashShellDialect) (string, error) {
	return encodePolicyForShell(client, allow, sensitiveEnvKeys, sensitivePaths, dialect, false)
}

func encodePolicyForShell(client Client, allow []catalog.BashRule, sensitiveEnvKeys []string, sensitivePaths []SensitivePath, dialect catalog.BashShellDialect, bashUnrestricted bool) (string, error) {
	if !validClient(client) {
		return "", policyError{}
	}
	if bashUnrestricted && client != ClientGrok || bashUnrestricted && len(allow) != 0 || !bashUnrestricted && (len(allow) == 0 || catalog.ValidateCapabilityBashRules(allow) != nil) {
		return "", policyError{}
	}
	patterns := make([]string, 0, len(allow))
	for _, rule := range allow {
		patterns = append(patterns, rule.Pattern)
	}
	keys := make([]string, 0, len(sensitiveEnvKeys))
	seen := map[string]bool{}
	for _, raw := range sensitiveEnvKeys {
		key := strings.TrimSpace(raw)
		if !validEnvKey(key) {
			return "", policyError{}
		}
		upper := strings.ToUpper(key)
		if !seen[upper] {
			seen[upper] = true
			keys = append(keys, key)
		}
	}
	paths, err := normalizeSensitivePaths(sensitivePaths)
	if err != nil {
		return "", policyError{}
	}
	if !catalog.ValidBashShellDialect(dialect) {
		return "", policyError{}
	}
	payload, err := json.Marshal(encodedPolicy{
		Version: 4, Client: client, BashAllow: patterns, BashUnrestricted: bashUnrestricted, SensitiveEnvKeys: keys, ShellDialect: dialect,
		SensitiveFilesystemPaths: paths,
	})
	if err != nil {
		return "", policyError{}
	}
	return base64.StdEncoding.EncodeToString(payload), nil
}

// Requested reports whether this process was launched as a BashGate hook. Any
// nonempty client marker is handled so an unknown value fails closed.
func Requested() bool {
	return strings.TrimSpace(os.Getenv(ModeEnv)) != ""
}

// Run evaluates one client-native PreToolUse payload. Every boundary failure
// emits an explicit, value-free denial and exits 2, which is the blocking hook
// status shared by Claude, CodeBuddy, Grok, and the OpenCode plugin adapter.
func Run(input io.Reader, output io.Writer, requestedClient, encoded string) int {
	deny := func(reason string) int {
		_ = json.NewEncoder(output).Encode(map[string]string{"decision": "deny", "reason": reason})
		return 2
	}

	client := Client(strings.TrimSpace(requestedClient))
	policy, ok := decodePolicy(client, encoded)
	if !ok {
		return deny("Forge BashGate denied an invalid policy")
	}
	payload, err := io.ReadAll(io.LimitReader(input, maxPayloadBytes+1))
	if err != nil || len(payload) == 0 || len(payload) > maxPayloadBytes {
		return deny("Forge BashGate denied malformed or truncated hook input")
	}
	request, reason, ok := decodeToolRequest(client, payload)
	if !ok {
		return deny(reason)
	}

	switch toolKind(client, request.name) {
	case "bash":
		command, ok := requiredString(request.input, "command")
		if !ok {
			return deny("Forge BashGate denied malformed shell tool input")
		}
		if reason, allowed := authorizeCommand(policy, command, request.cwd); !allowed {
			return deny(reason)
		}
	case "read":
		path, ok := requiredPath(request.input)
		if !ok || malformedPathFields(request.input) {
			return deny("Forge BashGate denied malformed read tool input")
		}
		if sensitivePath(path, request.cwd, pathAccessExact, policy.SensitiveEnvKeys, policy.SensitiveFilesystemPaths) || containsSensitiveValue(request.input, policy.SensitiveEnvKeys) {
			return deny("Forge BashGate denied access to process environment state")
		}
	case "grep":
		paths, valid := searchPathFields(request.input)
		if !valid || malformedPathFields(request.input) {
			return deny("Forge BashGate denied malformed grep tool input")
		}
		for _, path := range paths {
			if sensitivePath(path, request.cwd, pathAccessRecursive, policy.SensitiveEnvKeys, policy.SensitiveFilesystemPaths) {
				return deny("Forge BashGate denied access to process environment state")
			}
		}
		if containsSensitiveValue(request.input, policy.SensitiveEnvKeys) {
			return deny("Forge BashGate denied access to process environment state")
		}
	case "list":
		path, ok := requiredPath(request.input)
		if !ok || malformedPathFields(request.input) {
			return deny("Forge BashGate denied malformed listing tool input")
		}
		if sensitivePath(path, request.cwd, pathAccessListing, policy.SensitiveEnvKeys, policy.SensitiveFilesystemPaths) || containsSensitiveValue(request.input, policy.SensitiveEnvKeys) {
			return deny("Forge BashGate denied access to process environment state")
		}
	case "edit":
		path, ok := requiredEditPath(request.input)
		if !ok || hasPathGlob(path) || !validEditInput(request.input) {
			return deny("Forge BashGate denied malformed edit tool input")
		}
		if sensitivePath(path, request.cwd, pathAccessExact, policy.SensitiveEnvKeys, policy.SensitiveFilesystemPaths) || anySensitivePathField(request.input, request.cwd, pathAccessExact, policy.SensitiveEnvKeys, policy.SensitiveFilesystemPaths) {
			return deny("Forge BashGate denied a sensitive filesystem write")
		}
	default:
		return deny("Forge BashGate denied an unknown guarded tool")
	}

	if err := json.NewEncoder(output).Encode(map[string]string{"decision": "allow"}); err != nil {
		return 2
	}
	return 0
}

// AuthorizeCommand applies the same decoded, secret-free policy used by native
// BashGate hooks to one complete shell command. Restricted runtimes that own
// execution themselves use this boundary so command parsing and sensitive-path
// decisions cannot drift from the hook adapters.
func AuthorizeCommand(client Client, encoded, command, cwd string) (string, bool) {
	policy, ok := decodePolicy(client, encoded)
	if !ok {
		return "Forge BashGate denied an invalid policy", false
	}
	if strings.TrimSpace(command) == "" {
		return "Forge BashGate denied malformed shell tool input", false
	}
	return authorizeCommand(policy, command, cwd)
}

func authorizeCommand(policy encodedPolicy, command, cwd string) (string, bool) {
	if sensitiveCommand(command, policy.SensitiveEnvKeys) {
		return "Forge BashGate denied access to process environment state", false
	}
	if sensitive, valid := commandTargetsSensitivePath(command, cwd, policy.SensitiveFilesystemPaths, policy.ShellDialect); !valid {
		return "Forge BashGate denied malformed sensitive filesystem input", false
	} else if sensitive {
		return "Forge BashGate denied access to a sensitive filesystem path", false
	}
	if policy.BashUnrestricted {
		return "", true
	}
	rules := make([]catalog.BashRule, 0, len(policy.BashAllow))
	for _, pattern := range policy.BashAllow {
		rules = append(rules, catalog.BashRule{Pattern: pattern})
	}
	allowed := catalog.BashAllowedForShell(catalog.PermissionPolicy{
		BashEnabled: true,
		BashGate:    catalog.BashGate{Builtin: rules},
	}, command, policy.ShellDialect)
	if !allowed {
		return "Forge BashGate denied a command outside EffectiveBashAllow", false
	}
	return "", true
}

func decodePolicy(client Client, encoded string) (encodedPolicy, bool) {
	if !validClient(client) {
		return encodedPolicy{}, false
	}
	data, err := base64.StdEncoding.DecodeString(strings.TrimSpace(encoded))
	if err != nil {
		return encodedPolicy{}, false
	}
	var policy encodedPolicy
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&policy) != nil || decoder.Decode(&struct{}{}) != io.EOF || policy.Version != 4 || policy.Client != client || policy.BashUnrestricted && client != ClientGrok || policy.BashUnrestricted && len(policy.BashAllow) != 0 || !policy.BashUnrestricted && len(policy.BashAllow) == 0 {
		return encodedPolicy{}, false
	}
	rules := make([]catalog.BashRule, 0, len(policy.BashAllow))
	for _, pattern := range policy.BashAllow {
		rules = append(rules, catalog.BashRule{Pattern: pattern})
	}
	if !policy.BashUnrestricted && catalog.ValidateCapabilityBashRules(rules) != nil {
		return encodedPolicy{}, false
	}
	for _, key := range policy.SensitiveEnvKeys {
		if !validEnvKey(key) {
			return encodedPolicy{}, false
		}
	}
	if !validSensitivePaths(policy.SensitiveFilesystemPaths) {
		return encodedPolicy{}, false
	}
	if !catalog.ValidBashShellDialect(policy.ShellDialect) {
		return encodedPolicy{}, false
	}
	return policy, true
}

func decodeToolRequest(client Client, payload []byte) (toolRequest, string, bool) {
	var object map[string]json.RawMessage
	if json.Unmarshal(payload, &object) != nil || object == nil {
		return toolRequest{}, "Forge BashGate denied malformed hook input", false
	}
	if truncated, present, valid := optionalBool(object, "toolInputTruncated", "tool_input_truncated"); !valid || present && truncated {
		return toolRequest{}, "Forge BashGate denied truncated tool input", false
	} else if client == ClientGrok {
		var exact bool
		if raw, ok := object["toolInputTruncated"]; !ok || json.Unmarshal(raw, &exact) != nil || exact {
			return toolRequest{}, "Forge BashGate denied missing or truncated Grok tool input", false
		}
	}

	var nameKey, inputKey, eventKey string
	var wantEvent string
	if client == ClientGrok {
		nameKey, inputKey, eventKey, wantEvent = "toolName", "toolInput", "hookEventName", "pre_tool_use"
	} else {
		nameKey, inputKey, eventKey, wantEvent = "tool_name", "tool_input", "hook_event_name", "PreToolUse"
	}
	name, ok := rawString(object[nameKey])
	if !ok || strings.TrimSpace(name) == "" {
		return toolRequest{}, "Forge BashGate denied malformed tool identity", false
	}
	event, ok := rawString(object[eventKey])
	if !ok || !strings.EqualFold(strings.TrimSpace(event), wantEvent) {
		return toolRequest{}, "Forge BashGate denied an unexpected hook event", false
	}
	var toolInput map[string]any
	if raw, ok := object[inputKey]; !ok || json.Unmarshal(raw, &toolInput) != nil || toolInput == nil {
		return toolRequest{}, "Forge BashGate denied malformed tool input", false
	}
	cwd, _ := rawString(object["cwd"])
	return toolRequest{name: strings.TrimSpace(name), input: toolInput, cwd: strings.TrimSpace(cwd)}, "", true
}

func optionalBool(object map[string]json.RawMessage, names ...string) (value, present, valid bool) {
	valid = true
	for _, name := range names {
		raw, ok := object[name]
		if !ok {
			continue
		}
		if strings.TrimSpace(string(raw)) == "null" {
			return false, true, false
		}
		var decoded bool
		if json.Unmarshal(raw, &decoded) != nil {
			return false, true, false
		}
		if present && decoded != value {
			return false, true, false
		}
		value, present = decoded, true
	}
	return value, present, valid
}

func rawString(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 {
		return "", false
	}
	var value string
	return value, json.Unmarshal(raw, &value) == nil
}

func toolKind(client Client, name string) string {
	lower := strings.ToLower(strings.TrimSpace(name))
	if client == ClientGrok {
		switch lower {
		case "bash", "run_terminal_cmd", "run_terminal_command":
			return "bash"
		case "read", "read_file":
			return "read"
		case "grep":
			return "grep"
		case "glob", "listdir", "list_dir":
			return "list"
		case "search_replace", "edit", "write", "multiedit":
			return "edit"
		}
		return ""
	}
	if lower == "bash" {
		return "bash"
	}
	return ""
}

func requiredString(input map[string]any, key string) (string, bool) {
	value, ok := input[key].(string)
	return value, ok && strings.TrimSpace(value) != ""
}

func requiredPath(input map[string]any) (string, bool) {
	if _, exists := input["paths"]; exists {
		return "", false
	}
	var found string
	for _, key := range pathFieldNames() {
		if value, exists := input[key]; exists {
			path, ok := value.(string)
			if !ok || strings.TrimSpace(path) == "" || found != "" {
				return "", false
			}
			found = path
		}
	}
	return found, found != ""
}

func requiredEditPath(input map[string]any) (string, bool) {
	path, ok := input["file_path"].(string)
	return path, ok && strings.TrimSpace(path) != ""
}

func validEditInput(input map[string]any) bool {
	allowed := map[string]bool{"file_path": true, "old_string": true, "new_string": true, "replace_all": true}
	for key := range input {
		if !allowed[key] {
			return false
		}
	}
	oldString, oldOK := input["old_string"].(string)
	_, newOK := input["new_string"].(string)
	if !oldOK || strings.TrimSpace(oldString) == "" || !newOK || malformedPathFields(input) {
		return false
	}
	if value, exists := input["replace_all"]; exists {
		if _, ok := value.(bool); !ok {
			return false
		}
	}
	return true
}

func searchPathFields(input map[string]any) ([]string, bool) {
	patterns := 0
	for _, key := range []string{"pattern", "query", "regex"} {
		if value, exists := input[key]; exists {
			text, ok := value.(string)
			if !ok || strings.TrimSpace(text) == "" {
				return nil, false
			}
			patterns++
		}
	}
	if patterns != 1 {
		return nil, false
	}
	var paths []string
	fields := 0
	for _, key := range append(pathFieldNames(), "paths") {
		value, exists := input[key]
		if !exists {
			continue
		}
		fields++
		switch typed := value.(type) {
		case string:
			if strings.TrimSpace(typed) == "" {
				return nil, false
			}
			paths = append(paths, typed)
		case []any:
			if len(typed) == 0 {
				return nil, false
			}
			for _, item := range typed {
				text, ok := item.(string)
				if !ok || strings.TrimSpace(text) == "" {
					return nil, false
				}
				paths = append(paths, text)
			}
		default:
			return nil, false
		}
	}
	if fields > 1 {
		return nil, false
	}
	if len(paths) == 0 {
		paths = []string{"."}
	}
	return paths, true
}

func malformedPathFields(input map[string]any) bool {
	for _, key := range append(pathFieldNames(), "paths") {
		value, exists := input[key]
		if !exists {
			continue
		}
		switch typed := value.(type) {
		case string:
			if strings.TrimSpace(typed) == "" {
				return true
			}
		case []any:
			if len(typed) == 0 {
				return true
			}
			for _, item := range typed {
				text, ok := item.(string)
				if !ok || strings.TrimSpace(text) == "" {
					return true
				}
			}
		default:
			return true
		}
	}
	return false
}

func anySensitivePathField(input map[string]any, cwd string, access pathAccess, sensitiveEnvKeys []string, sensitivePaths []SensitivePath) bool {
	for _, key := range append(pathFieldNames(), "paths") {
		value, exists := input[key]
		if !exists {
			continue
		}
		switch typed := value.(type) {
		case string:
			if sensitivePath(typed, cwd, access, sensitiveEnvKeys, sensitivePaths) {
				return true
			}
		case []any:
			for _, item := range typed {
				text, _ := item.(string)
				if sensitivePath(text, cwd, access, sensitiveEnvKeys, sensitivePaths) {
					return true
				}
			}
		}
	}
	return false
}

func pathFieldNames() []string {
	// Grok 0.2.106 emits target_file/target_directory in native tool input;
	// its compatibility aliases and hook metadata also expose path/file_path/
	// directory. Treat every verified spelling as the same security boundary.
	return []string{"path", "file_path", "target_file", "directory", "target_directory", "root"}
}

func sensitiveCommand(command string, sensitiveEnvKeys []string) bool {
	return environmentCommand.MatchString(command) || sensitiveText(command, sensitiveEnvKeys)
}

func containsSensitiveValue(value any, sensitiveEnvKeys []string) bool {
	switch typed := value.(type) {
	case string:
		return sensitiveText(typed, sensitiveEnvKeys)
	case []any:
		for _, item := range typed {
			if containsSensitiveValue(item, sensitiveEnvKeys) {
				return true
			}
		}
	case map[string]any:
		for _, item := range typed {
			if containsSensitiveValue(item, sensitiveEnvKeys) {
				return true
			}
		}
	}
	return false
}

func sensitiveText(value string, sensitiveEnvKeys []string) bool {
	lower := strings.ToLower(value)
	for _, key := range sensitiveEnvKeys {
		if strings.Contains(lower, strings.ToLower(key)) {
			return true
		}
	}
	normalized := cleanSlashPath(value)
	return processEnvironmentPath.MatchString(normalized) || strings.Contains(lower, "env:") || strings.Contains(lower, "environment::")
}

func normalizePathText(value string) string {
	return strings.ReplaceAll(strings.TrimSpace(value), `\`, "/")
}

func validClient(client Client) bool {
	return client == ClientGrok || client == ClientClaude || client == ClientCodeBuddy || client == ClientOpenCode || client == ClientCodex
}

func validEnvKey(value string) bool {
	if value == "" {
		return false
	}
	for index, r := range value {
		if index == 0 && !(r == '_' || r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z') {
			return false
		}
		if !(r == '_' || r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9') {
			return false
		}
	}
	return true
}

type policyError struct{}

func (policyError) Error() string { return "BashGate policy is invalid" }
