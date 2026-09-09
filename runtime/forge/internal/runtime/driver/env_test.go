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
	t.Setenv("CURSOR_AUTH_TOKEN", "tok-cursor-inherited")
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
	t.Setenv("WRENYARD_GATEWAY_MODELS_JSON", `[{"id":"secret-free-but-internal"}]`)
	t.Setenv("WRENYARD_DISPATCH_PLANS_JSON", `{"profile":{"client":"codex"}}`)
	t.Setenv("FORGE_TEST_BENIGN_VAR", "benign-value")

	env := envListToMap(BuildChildEnv(nil))
	for _, key := range []string{
		"ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN",
		"CLAUDE_CONFIG_DIR", "CLAUDE_JOB_DIR",
		"CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "CODEX_HOME",
		"CURSOR_AUTH_TOKEN",
		"OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG_DIR", "OPENCODE_PERMISSION",
		"FORGE_INTERNAL_OPENCODE_BASH_GATE_EXECUTABLE", "FORGE_INTERNAL_OPENCODE_BASH_PERMISSION",
		"FORGE_PROFILE", "FORGE_REPO_DIR", "FORGE_BINARY",
		"WRENYARD_GATEWAY_MODELS_JSON", "WRENYARD_DISPATCH_PLANS_JSON",
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
		"cursor_auth_token=tok-cursor-low",
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
		"CODEX_ACCESS_TOKEN", "Codex_Home", "cursor_auth_token",
		"git_dir", "GIT_WORK_TREE",
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
		map[string]string{
			"Path":              "/planned/bin",
			"CODEX_API_KEY":     "planned-key",
			"CURSOR_AUTH_TOKEN": "planned-cursor-token",
		},
		[]string{
			"PATH=/parent/bin",
			"CODEX_API_KEY=parent-key",
			"CURSOR_AUTH_TOKEN=parent-cursor-token",
			"BENIGN=kept",
		},
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
	if got := env["CURSOR_AUTH_TOKEN"]; got != "planned-cursor-token" {
		t.Fatalf("explicit planned CURSOR_AUTH_TOKEN = %q, want planned-cursor-token: %v", got, result)
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

// TestBuildChildEnvStripsCodeBuddyPrivateAdmissionContext proves that the
// three Forge-private CodeBuddy admission context vars are stripped from both
// inherited and planned inputs, case-insensitively even when
// caseInsensitive=false, on both yolo and restricted permission modes, while
// benign planned credential/model env may still be supplied unchanged.
func TestBuildChildEnvStripsCodeBuddyPrivateAdmissionContext(t *testing.T) {
	inherited := []string{
		"WRENYARD_CODEBUDDY_EXPECTED_SCOPE=inherited-scope",
		"wrenyard_codebuddy_expected_environment=inherited-env",
		"WrEnYaRd_CoDeBuDdY_ExPeCtEd_WiRe_MoDeL=inherited-wire",
		"WRENYARD_CODEBUDDY_EXPECTED_SCOPE_EXTRA=not-private",
		"PATH=/usr/bin",
	}
	planned := map[string]string{
		"WRENYARD_CODEBUDDY_EXPECTED_SCOPE":       "planned-scope",
		"wrenyard_codebuddy_expected_environment": "planned-env",
		"WRENYARD_CODEBUDDY_EXPECTED_WIRE_MODEL":  "planned-wire",
		"CODEX_API_KEY":                           "planned-credential",
		"ANTHROPIC_DEFAULT_SONNET_MODEL":          "planned-model",
		"FORGE_TEST_BENIGN_VAR":                   "planned-benign",
	}
	for _, tc := range []struct {
		name string
		mode catalog.PermissionMode
	}{
		{name: "yolo", mode: catalog.PermissionYolo},
		{name: "restricted", mode: catalog.PermissionReadonly},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, insensitive := range []bool{false, true} {
				label := "case-insensitive"
				if !insensitive {
					label = "case-sensitive"
				}
				t.Run(label, func(t *testing.T) {
					rendered := buildChildEnvForPermission(planned, inherited, insensitive, tc.mode, "/dev/null")
					joined := strings.Join(rendered, "\n")
					for _, private := range []string{
						"inherited-scope", "inherited-env", "inherited-wire",
						"planned-scope", "planned-env", "planned-wire",
					} {
						if strings.Contains(joined, private) {
							t.Fatalf("CodeBuddy private admission context value %q survived in %s mode (case-insensitive=%v):\n%s", private, tc.name, insensitive, joined)
						}
					}
					env := envListToMap(rendered)
					if _, ok := env["WRENYARD_CODEBUDDY_EXPECTED_SCOPE"]; ok {
						t.Fatalf("mode=%s: expected WRENYARD_CODEBUDDY_EXPECTED_SCOPE stripped from planned/inherited env", tc.name)
					}
					if got := env["WRENYARD_CODEBUDDY_EXPECTED_SCOPE_EXTRA"]; got != "not-private" {
						t.Fatalf("mode=%s: similar-but-public key must stay inherited, got %q", tc.name, got)
					}
					// Benign planned credential/model env keeps the existing
					// planned-overlay behavior unchanged.
					if got := env["CODEX_API_KEY"]; got != "planned-credential" {
						t.Fatalf("mode=%s: planned CODEX_API_KEY = %q, want planned-credential", tc.name, got)
					}
					if got := env["ANTHROPIC_DEFAULT_SONNET_MODEL"]; got != "planned-model" {
						t.Fatalf("mode=%s: planned ANTHROPIC_DEFAULT_SONNET_MODEL = %q, want planned-model", tc.name, got)
					}
					if got := env["FORGE_TEST_BENIGN_VAR"]; got != "planned-benign" {
						t.Fatalf("mode=%s: planned benign var = %q, want planned-benign", tc.name, got)
					}
				})
			}
		})
	}
}
