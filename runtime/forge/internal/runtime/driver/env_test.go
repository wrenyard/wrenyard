package driver

import (
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

func TestBuildChildEnvDeniesManagedAndGitKeys(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "sk-test-anthropic")
	t.Setenv("ANTHROPIC_BASE_URL", "https://parent.invalid")
	t.Setenv("ANTHROPIC_AUTH_TOKEN", "tok-anthropic")
	t.Setenv("CLAUDE_CONFIG_DIR", "/parent/claude")
	t.Setenv("CLAUDE_JOB_DIR", "/parent/jobs")
	t.Setenv("CODEX_API_KEY", "sk-test-codex")
	t.Setenv("CODEX_ACCESS_TOKEN", "tok-codex")
	t.Setenv("CODEX_HOME", "/home/codex-test")
	t.Setenv("OPENCODE_CONFIG", "/parent/opencode.json")
	t.Setenv("OPENCODE_CONFIG_CONTENT", `{"permission":"allow"}`)
	t.Setenv("OPENCODE_CONFIG_DIR", "/parent/opencode")
	t.Setenv("OPENCODE_PERMISSION", "allow")
	t.Setenv("FORGE_INTERNAL_OPENCODE_BASH_GATE_EXECUTABLE", "/parent/forge")
	t.Setenv("FORGE_INTERNAL_OPENCODE_BASH_PERMISSION", `{"*":"allow"}`)
	t.Setenv("GIT_DIR", "/parent/.git")
	t.Setenv("GIT_WORK_TREE", "/parent/work")
	t.Setenv("GIT_INDEX_FILE", "/parent/.git/index")
	t.Setenv("GIT_COMMON_DIR", "/parent/.git/modules")
	t.Setenv("FORGE_PROFILE", "parent-profile")
	t.Setenv("FORGE_REPO_DIR", "/parent/repo")
	t.Setenv("FORGE_BINARY", "/parent/forge")
	t.Setenv("FORGE_TEST_BENIGN_VAR", "benign-value")

	env := envListToMap(BuildChildEnv(nil))
	for _, key := range []string{
		"ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN",
		"CLAUDE_CONFIG_DIR", "CLAUDE_JOB_DIR",
		"CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "CODEX_HOME",
		"OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG_DIR", "OPENCODE_PERMISSION",
		"FORGE_INTERNAL_OPENCODE_BASH_GATE_EXECUTABLE", "FORGE_INTERNAL_OPENCODE_BASH_PERMISSION",
		"FORGE_PROFILE", "FORGE_REPO_DIR", "FORGE_BINARY",
		"GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR",
	} {
		if _, ok := env[key]; ok {
			t.Fatalf("expected %s to be stripped from child env", key)
		}
	}
	if got := env["FORGE_TEST_BENIGN_VAR"]; got != "benign-value" {
		t.Fatalf("expected benign value to be inherited, got %q", got)
	}
}

func TestBuildChildEnvDeniesKeysCaseInsensitively(t *testing.T) {
	environ := []string{
		"anthropic_api_key=sk-low",
		"claude_config_dir=/parent/claude",
		"codex_api_key=sk-codex",
		"CODEX_ACCESS_TOKEN=tok-mixed",
		"Codex_Home=/home/low",
		"git_dir=/repo/.git",
		"GIT_WORK_TREE=/repo/work-low",
		"Git_Index_File=/repo/.git/index",
		"GIT_COMMON_DIR=/repo/.git/modules-low",
		"PATH=/usr/bin",
	}
	result := buildChildEnv(nil, environ, true)
	env := envListToMap(result)

	for _, key := range []string{
		"anthropic_api_key", "claude_config_dir", "codex_api_key",
		"CODEX_ACCESS_TOKEN", "Codex_Home", "git_dir", "GIT_WORK_TREE",
		"Git_Index_File", "GIT_COMMON_DIR",
	} {
		if _, ok := env[key]; ok {
			t.Fatalf("expected %s to be stripped case-insensitively: %v", key, result)
		}
	}
	if got := env["PATH"]; got != "/usr/bin" {
		t.Fatalf("expected PATH to be inherited, got %q", got)
	}
}

func TestBuildChildEnvDeniesLowercaseClaudeModelOnWindows(t *testing.T) {
	environ := []string{
		"anthropic_default_opus_model=parent-opus-low",
		"anthropic_default_sonnet_model_name=parent-sonnet-low",
		"anthropic_default_haiku_model_description=parent-desc-low",
		"anthropic_default_model_supported_capabilities=parent-caps-low",
		"PATH=/usr/bin",
	}
	result := buildChildEnv(nil, environ, true)
	env := envListToMap(result)

	for _, key := range []string{
		"anthropic_default_opus_model",
		"anthropic_default_sonnet_model_name",
		"anthropic_default_haiku_model_description",
		"anthropic_default_model_supported_capabilities",
	} {
		if _, ok := env[key]; ok {
			t.Fatalf("expected %s to be stripped case-insensitively: %v", key, result)
		}
	}
	if got := env["PATH"]; got != "/usr/bin" {
		t.Fatalf("expected PATH to be inherited, got %q", got)
	}
	if count := countEnvKey(result, "PATH", true); count != 1 {
		t.Fatalf("expected one PATH entry, got %d in %v", count, result)
	}
}

func TestBuildChildEnvPlannedOverlayWins(t *testing.T) {
	result := buildChildEnv(
		map[string]string{"Path": "/planned/bin", "CODEX_API_KEY": "planned-key"},
		[]string{"PATH=/parent/bin", "CODEX_API_KEY=parent-key", "BENIGN=kept"},
		true,
	)
	env := envListToMap(result)

	if got := env["Path"]; got != "/planned/bin" {
		t.Fatalf("planned PATH overlay = %q, want /planned/bin: %v", got, result)
	}
	if _, ok := env["PATH"]; ok {
		t.Fatalf("case-insensitive parent PATH should be replaced: %v", result)
	}
	if got := env["CODEX_API_KEY"]; got != "planned-key" {
		t.Fatalf("planned managed key = %q, want planned-key: %v", got, result)
	}
	if got := env["BENIGN"]; got != "kept" {
		t.Fatalf("benign inherited value = %q, want kept", got)
	}
	if count := countEnvKey(result, "PATH", true); count != 1 {
		t.Fatalf("expected one case-insensitive PATH entry, got %d: %v", count, result)
	}
}

func TestBuildChildEnvStripsStaleGrokCredentialsAndCaseVariants(t *testing.T) {
	inherited := []string{
		"PATH=C:\\tools",
		"GROK_HOME=C:\\shell-grok",
		"XAI_API_KEY=stale-xai",
		"forge_grok_zhipu_coding_api_key=stale-lower",
		"FORGE_GROK_KIMI_CODING_API_KEY=stale-kimi",
	}
	planned := map[string]string{
		"GROK_HOME":                       "C:\\agent-grok\\run-1",
		"FORGE_GROK_ZHIPU_CODING_API_KEY": "fresh-zhipu",
	}
	env := buildChildEnv(planned, inherited, true)
	joined := strings.Join(env, "\n")
	for _, stale := range []string{"stale-xai", "stale-lower", "stale-kimi", "shell-grok"} {
		if strings.Contains(joined, stale) {
			t.Fatalf("stale Grok environment value %q survived:\n%s", stale, joined)
		}
	}
	for _, want := range []string{"GROK_HOME=C:\\agent-grok\\run-1", "FORGE_GROK_ZHIPU_CODING_API_KEY=fresh-zhipu"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("planned canonical Grok env missing %q:\n%s", want, joined)
		}
	}
}

func TestRestrictedChildEnvReplacesConfigurationInjectionAndYoloDoesNot(t *testing.T) {
	inherited := []string{
		"PATH=/tools",
		"RIPGREP_CONFIG_PATH=/hostile/rg.conf",
		"GIT_EXTERNAL_DIFF=/hostile/diff",
		"GIT_CONFIG_PARAMETERS='core.fsmonitor=/hostile/fsmonitor'",
		"GIT_CONFIG_COUNT=1",
		"GIT_CONFIG_KEY_0=core.fsmonitor",
		"GIT_CONFIG_VALUE_0=/hostile/fsmonitor",
	}
	planned := map[string]string{
		"FORGE_SELECTED_CREDENTIAL": "selected-secret",
		"GIT_CONFIG_COUNT":          "1",
		"GIT_CONFIG_KEY_0":          "core.pager",
		"GIT_CONFIG_VALUE_0":        "/hostile/pager",
	}
	restricted := envListToMap(buildChildEnvForPermission(planned, inherited, false, catalog.PermissionReadonly, "/dev/null"))
	for _, key := range []string{"RIPGREP_CONFIG_PATH", "GIT_EXTERNAL_DIFF", "GIT_CONFIG_PARAMETERS"} {
		if _, ok := restricted[key]; ok {
			t.Fatalf("restricted environment retained %s", key)
		}
	}
	if restricted["GIT_CONFIG_COUNT"] != "6" || restricted["GIT_CONFIG_VALUE_0"] != "false" || restricted["GIT_CONFIG_GLOBAL"] != "/dev/null" {
		t.Fatalf("restricted Git normalization = %#v", restricted)
	}
	if restricted["FORGE_SELECTED_CREDENTIAL"] != "selected-secret" {
		t.Fatal("restricted normalization dropped the selected provider credential")
	}

	yolo := envListToMap(buildChildEnvForPermission(planned, inherited, false, catalog.PermissionYolo, "/dev/null"))
	if yolo["RIPGREP_CONFIG_PATH"] != "/hostile/rg.conf" || yolo["GIT_EXTERNAL_DIFF"] != "/hostile/diff" || yolo["GIT_CONFIG_VALUE_0"] != "/hostile/pager" {
		t.Fatalf("yolo environment was hardened unexpectedly: %#v", yolo)
	}
}

func envListToMap(entries []string) map[string]string {
	out := make(map[string]string, len(entries))
	for _, entry := range entries {
		key, value, ok := strings.Cut(entry, "=")
		if ok {
			out[key] = value
		}
	}
	return out
}

func countEnvKey(entries []string, key string, caseInsensitive bool) int {
	count := 0
	for _, entry := range entries {
		entryKey, _, ok := strings.Cut(entry, "=")
		if !ok {
			continue
		}
		if caseInsensitive && strings.EqualFold(entryKey, key) || !caseInsensitive && entryKey == key {
			count++
		}
	}
	return count
}
