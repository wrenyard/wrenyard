package driver

import (
	"os"
	"runtime"
	"sort"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

// IsClaudeDefaultModelEnv reports whether key is an ANTHROPIC_DEFAULT_*_MODEL*
// environment variable that forge internally manages for Claude profile model
// resolution (shared predicate — single source of truth).
func IsClaudeDefaultModelEnv(key string) bool {
	if !strings.HasPrefix(key, "ANTHROPIC_DEFAULT_") {
		return false
	}
	return strings.HasSuffix(key, "_MODEL") ||
		strings.HasSuffix(key, "_MODEL_NAME") ||
		strings.HasSuffix(key, "_MODEL_DESCRIPTION") ||
		strings.HasSuffix(key, "_MODEL_SUPPORTED_CAPABILITIES")
}

// BuildChildEnv builds a child-process environment by inheriting the full
// parent os.Environ(), deleting forge-managed variables that must not leak
// (auth / profile / model-resolution keys), then overlaying planned
// entries (later wins). On Windows key matching is case-insensitive.
func BuildChildEnv(planned map[string]string) []string {
	return buildChildEnv(planned, os.Environ(), runtime.GOOS == "windows")
}

// BuildChildEnvForPermission applies the additional hermetic environment
// boundary required by restricted Bash execution. Yolo deliberately retains
// its inherited ripgrep and Git configuration trust boundary.
func BuildChildEnvForPermission(planned map[string]string, permission catalog.PermissionMode) []string {
	return buildChildEnvForPermission(planned, os.Environ(), runtime.GOOS == "windows", permission, os.DevNull)
}

// denylistKeys returns the set of env keys forge must strip from inherited
// parent environment before overlaying planned values.
func denylistKeys() []string {
	return []string{
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_BASE_URL",
		"ANTHROPIC_AUTH_TOKEN",
		"CLAUDE_CONFIG_DIR",
		"CLAUDE_JOB_DIR",
		"CODEX_API_KEY",
		"CODEX_ACCESS_TOKEN",
		"CODEX_HOME",
		"GROK_HOME",
		"XAI_API_KEY",
		"OPENCODE_CONFIG",
		"OPENCODE_CONFIG_CONTENT",
		"OPENCODE_CONFIG_DIR",
		"OPENCODE_PERMISSION",
		"FORGE_PROFILE",
		"FORGE_REPO_DIR",
		"FORGE_BINARY",
		"FORGE_INTERNAL_BASH_GATE_CLIENT",
		"FORGE_INTERNAL_BASH_GATE_POLICY",
		"FORGE_INTERNAL_OPENCODE_BASH_GATE_EXECUTABLE",
		"FORGE_INTERNAL_OPENCODE_BASH_PERMISSION",
		"FORGE_MCP_HTTP_HEADERS_JSON",
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_INDEX_FILE",
		"GIT_COMMON_DIR",
	}
}

// buildChildEnv is the inner implementation, accepting environ and a
// case-insensitive flag for testability.
func buildChildEnv(planned map[string]string, environ []string, caseInsensitive bool) []string {
	return buildChildEnvForPermission(planned, environ, caseInsensitive, catalog.PermissionYolo, os.DevNull)
}

func buildChildEnvForPermission(planned map[string]string, environ []string, caseInsensitive bool, permission catalog.PermissionMode, nullDevice string) []string {
	restricted := permission != catalog.PermissionYolo
	// Build a case-normalized denylist set (uppercase on Windows).
	deny := make(map[string]bool, len(denylistKeys()))
	for _, k := range denylistKeys() {
		deny[normalizeEnvKey(k, caseInsensitive)] = true
	}

	// 1. Inherit all parent env entries.
	env := make(map[string]string, len(environ)+len(planned))
	for _, entry := range environ {
		key, value, ok := strings.Cut(entry, "=")
		if !ok {
			continue
		}
		// 2. Drop forge-managed denylist keys (and ANTHROPIC_DEFAULT_*_MODEL*).
		if deny[normalizeEnvKey(key, caseInsensitive)] {
			continue
		}
		if restricted && restrictedConfigurationInjectionKey(key, caseInsensitive) {
			continue
		}
		// Normalize before predicate so that lower/mixed-case keys
		// inherited on Windows still match the upper-case prefix/suffix
		// checks inside IsClaudeDefaultModelEnv.
		if IsClaudeDefaultModelEnv(normalizeEnvKey(key, caseInsensitive)) {
			continue
		}
		upperKey := strings.ToUpper(key)
		if strings.HasPrefix(upperKey, "FORGE_GROK_") && strings.HasSuffix(upperKey, "_API_KEY") {
			continue
		}
		env[key] = value
	}

	// 3. Overlay planned entries (case-insensitive replacement on Windows).
	for pk, pv := range planned {
		if restricted && restrictedConfigurationInjectionKey(pk, caseInsensitive) {
			continue
		}
		if caseInsensitive {
			upper := strings.ToUpper(pk)
			for ek := range env {
				if strings.ToUpper(ek) == upper {
					delete(env, ek)
					break
				}
			}
		}
		env[pk] = pv
	}
	if restricted {
		// These values have command-line config precedence over system, global,
		// and repository config. The remaining granted Git commands cannot use
		// a configured fsmonitor or pager even when the repository is hostile.
		hermetic := map[string]string{
			"GIT_ATTR_NOSYSTEM":   "1",
			"GIT_CONFIG_NOSYSTEM": "1",
			"GIT_CONFIG_SYSTEM":   nullDevice,
			"GIT_CONFIG_GLOBAL":   nullDevice,
			"GIT_PAGER":           "",
			"GIT_CONFIG_COUNT":    "6",
			"GIT_CONFIG_KEY_0":    "core.fsmonitor",
			"GIT_CONFIG_VALUE_0":  "false",
			"GIT_CONFIG_KEY_1":    "core.pager",
			"GIT_CONFIG_VALUE_1":  "",
			"GIT_CONFIG_KEY_2":    "pager.status",
			"GIT_CONFIG_VALUE_2":  "false",
			"GIT_CONFIG_KEY_3":    "pager.branch",
			"GIT_CONFIG_VALUE_3":  "false",
			"GIT_CONFIG_KEY_4":    "pager.grep",
			"GIT_CONFIG_VALUE_4":  "false",
			"GIT_CONFIG_KEY_5":    "pager.ls-files",
			"GIT_CONFIG_VALUE_5":  "false",
		}
		for key, value := range hermetic {
			deleteCaseVariant(env, key, caseInsensitive)
			env[key] = value
		}
	}

	// 4. Render sorted "K=V" slice.
	keys := make([]string, 0, len(env))
	for key := range env {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	rendered := make([]string, 0, len(keys))
	for _, key := range keys {
		rendered = append(rendered, key+"="+env[key])
	}
	return rendered
}

func restrictedConfigurationInjectionKey(key string, caseInsensitive bool) bool {
	key = normalizeEnvKey(key, caseInsensitive)
	return key == "RIPGREP_CONFIG_PATH" || key == "GIT_EXTERNAL_DIFF" || key == "GIT_PAGER" ||
		key == "GIT_ATTR_NOSYSTEM" || strings.HasPrefix(key, "GIT_CONFIG_")
}

func deleteCaseVariant(env map[string]string, key string, caseInsensitive bool) {
	if !caseInsensitive {
		delete(env, key)
		return
	}
	for existing := range env {
		if strings.EqualFold(existing, key) {
			delete(env, existing)
		}
	}
}

// normalizeEnvKey returns key uppercased on Windows (case-insensitive
// matching) and as-is on other platforms.
func normalizeEnvKey(key string, caseInsensitive bool) string {
	if caseInsensitive {
		return strings.ToUpper(key)
	}
	return key
}
