package driver

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/bashgate"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

// expandHome expands a single leading ~ or ~/ prefix using the user's home
// directory. Preserves the exact behavior of the root forge helper.
func expandHome(value string) string {
	if value == "~" {
		home, err := os.UserHomeDir()
		if err != nil {
			return value
		}
		return home
	}
	if strings.HasPrefix(value, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return value
		}
		return filepath.Join(home, value[2:])
	}
	return value
}

// splitCommand splits a shell-style command string honoring single/double
// quotes and backslash escaping, expanding ~ in each resulting token. This is
// the verbatim port of the root forge splitCommand helper.
func splitCommand(raw string) []string {
	parts := []string{}
	var current strings.Builder
	inSingle, inDouble, escape := false, false, false
	for _, r := range raw {
		switch {
		case escape:
			current.WriteRune(r)
			escape = false
		case r == '\\' && !inSingle:
			escape = true
		case r == '\'' && !inDouble:
			inSingle = !inSingle
		case r == '"' && !inSingle:
			inDouble = !inDouble
		case (r == ' ' || r == '\t') && !inSingle && !inDouble:
			if current.Len() > 0 {
				parts = append(parts, expandHome(current.String()))
				current.Reset()
			}
		default:
			current.WriteRune(r)
		}
	}
	if current.Len() > 0 {
		parts = append(parts, expandHome(current.String()))
	}
	return parts
}

func hasFlag(args []string, flag string) bool {
	for _, arg := range args {
		if arg == flag || strings.HasPrefix(arg, flag+"=") {
			return true
		}
	}
	return false
}

func removeFlag(args []string, flag string) []string {
	var result []string
	for _, arg := range args {
		if arg == flag {
			continue
		}
		result = append(result, arg)
	}
	return result
}

func stringField(m map[string]interface{}, key, fallback string) string {
	if value, ok := m[key].(string); ok && value != "" {
		return value
	}
	return fallback
}

func stringSliceField(m map[string]interface{}, key string, fallback []string) []string {
	raw, ok := m[key].([]interface{})
	if !ok {
		return fallback
	}
	out := []string{}
	for _, item := range raw {
		out = append(out, fmt.Sprint(item))
	}
	return out
}

func defaultCommand(spec ProfileSpec) string {
	if spec.Client == "opencode" {
		return "opencode"
	}
	return "claude"
}

func modelFromArgs(args []string) string {
	for i, a := range args {
		if a == "--model" && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}

func mergeJSONObjects(a, b string) string {
	var ma, mb map[string]any
	if json.Unmarshal([]byte(a), &ma) != nil || json.Unmarshal([]byte(b), &mb) != nil {
		return a
	}
	for k, v := range mb {
		ma[k] = v
	}
	data, err := json.Marshal(ma)
	if err != nil {
		return a
	}
	return string(data)
}

// ResolveBinary locates the client binary honoring the catalog.BinarySpec:
// node-based entry via npm global prefix, then LookPath with corrupt-.cmd-shim
// detection. Preserves the exact error text and argv behavior of the root
// forge helper.
func ResolveBinary(spec catalog.BinarySpec) ([]string, error) {
	if spec.NodeEntry != "" {
		prefix, err := npmGlobalPrefix()
		if err == nil {
			scriptPath := filepath.Join(prefix, spec.NodeEntry)
			if _, statErr := os.Stat(scriptPath); statErr == nil {
				return []string{"node", scriptPath}, nil
			}
		}
	}

	name := spec.Name
	if runtime.GOOS == "windows" && spec.WindowsCmd != "" {
		name = spec.WindowsCmd
	}
	path, err := exec.LookPath(name)
	if err != nil {
		return nil, fmt.Errorf("could not find %q on PATH; is it installed?", name)
	}

	if runtime.GOOS == "windows" && strings.HasSuffix(strings.ToLower(path), ".cmd") {
		data, readErr := os.ReadFile(path)
		if readErr == nil && len(data) >= 2 && data[0] == '#' && data[1] == '!' {
			return nil, fmt.Errorf(
				"corrupt %s shim detected (starts with shebang). Run: npm install -g @tencent-ai/codebuddy-code",
				filepath.Base(path),
			)
		}
	}

	return []string{path}, nil
}

// npmGlobalPrefix returns the npm global prefix directory.
func npmGlobalPrefix() (string, error) {
	if runtime.GOOS == "windows" {
		appData := os.Getenv("APPDATA")
		if appData == "" {
			home, err := os.UserHomeDir()
			if err != nil {
				return "", err
			}
			appData = filepath.Join(home, "AppData", "Roaming")
		}
		return filepath.Join(appData, "npm"), nil
	}
	out, err := exec.Command("npm", "prefix", "-g").Output()
	if err == nil {
		prefix := strings.TrimSpace(string(out))
		if prefix != "" {
			return prefix, nil
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".npm"), nil
}

// ClaudeConfigDir returns the isolated CC config directory derived from the
// passed forge data dir.
func ClaudeConfigDir(forgeDataDir string) string {
	return filepath.Join(forgeDataDir, "claude", "direct-cc", "config")
}

// ClaudeJobDir returns the isolated CC job directory derived from the passed
// forge data dir.
func ClaudeJobDir(forgeDataDir string) string {
	return filepath.Join(forgeDataDir, "claude", "direct-cc", "jobs")
}

func ensureCCDirs(forgeDataDir string) error {
	for _, dir := range []string{ClaudeConfigDir(forgeDataDir), ClaudeJobDir(forgeDataDir)} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	return nil
}

func claudeDefaultModel(spec ProfileSpec) string {
	defaultArgs := stringSliceField(spec.Launcher, "default_args", nil)
	for i, arg := range defaultArgs {
		if arg == "--model" && i+1 < len(defaultArgs) {
			return defaultArgs[i+1]
		}
		if strings.HasPrefix(arg, "--model=") {
			return strings.TrimPrefix(arg, "--model=")
		}
	}
	if spec.Supports1M {
		return "opus[1m]"
	}
	return "opus"
}

func claudeModelOverrides(spec ProfileSpec) map[string]string {
	raw, ok := spec.Settings["modelOverrides"].(map[string]interface{})
	if !ok || len(raw) == 0 {
		return nil
	}
	out := map[string]string{}
	for key, value := range raw {
		if stringValue, ok := value.(string); ok && key != "" && stringValue != "" {
			out[key] = stringValue
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func codeBuddyDirectInlineSettings(spec ProfileSpec) string {
	overrides := claudeModelOverrides(spec)
	if len(overrides) == 0 {
		return ""
	}
	payload, err := json.Marshal(map[string]any{
		"modelOverrides": overrides,
	})
	if err != nil {
		return ""
	}
	return string(payload)
}

func claudeFamilyInlineSettings(spec ProfileSpec, mode catalog.PermissionMode) (string, error) {
	settings := map[string]any{}
	if existing := codeBuddyDirectInlineSettings(spec); existing != "" {
		if err := json.Unmarshal([]byte(existing), &settings); err != nil {
			return "", fmt.Errorf("decode Claude-family inline settings: %w", err)
		}
	}
	if mode != catalog.PermissionYolo {
		executable, err := os.Executable()
		if err != nil {
			return "", fmt.Errorf("resolve Forge executable for Claude-family BashGate: %w", err)
		}
		hookData, err := bashgate.ClaudeFamilySettingsBytes(executable)
		if err != nil {
			return "", err
		}
		var hookSettings map[string]any
		if err := json.Unmarshal(hookData, &hookSettings); err != nil {
			return "", fmt.Errorf("decode Claude-family BashGate settings: %w", err)
		}
		settings["hooks"] = hookSettings["hooks"]
	}
	if len(settings) == 0 {
		return "", nil
	}
	data, err := json.Marshal(settings)
	if err != nil {
		return "", fmt.Errorf("encode Claude-family inline settings: %w", err)
	}
	return string(data), nil
}

func codexSandboxMode(spec ProfileSpec) string {
	if sandbox := strings.TrimSpace(spec.Env["CODEX_SANDBOX"]); sandbox != "" {
		return sandbox
	}
	return "workspace-write"
}

// catalogDialectError returns a uniform error for an unrecognized dialect. The
// resolved client/provider is never expected to carry an empty/unknown dialect
// at this stage, so the message uses the profile name and client id.
func catalogDialectError(spec ProfileSpec) error {
	return fmt.Errorf("profile %q (client %q) has no supported direct runtime dialect", spec.Name, spec.Client)
}
