package manifest

import (
	"testing"
)

func TestBuiltinProfileSet(t *testing.T) {
	all := List()

	// Verify exact active profiles are present.
	wantActive := map[string]bool{
		"codex-sol":   true,
		"codex-terra": true,
		"codex-luna":  true,
		"codex-spark": true,
		"cb-hy":       true,
		"cb-ds":       true,
		"cb-dsf":      true,
		"cb-kimi":     true,
		"cc-kimi":     true,
		"cc-glm":      true,
		"gk-glm":      true,
		"gk-kimi":     true,
		"gk-grok":     true,
	}
	// Verify no retired or removed profiles.
	notWant := map[string]bool{
		"ccb":         true,
		"ccds":        true,
		"ccg":         true,
		"cck":         true,
		"ccc":         true,
		"oci":         true,
		"oc":          true,
		"oc-gpt":      true,
		"codex":       true,
		"codex-high":  true,
		"codex-xhigh": true,
		"codex-lite":  true,
		"codex-mini":  true,
		"cb-glm":      true,
	}

	got := make(map[string]bool)
	for _, id := range all {
		got[id] = true
	}

	for id := range wantActive {
		if !got[id] {
			t.Errorf("missing active profile %q", id)
		}
	}
	for id := range notWant {
		if got[id] {
			t.Errorf("unexpected retired profile %q", id)
		}
	}

	// Verify no extra unexpected profiles.
	for id := range got {
		if !wantActive[id] {
			t.Errorf("unknown profile %q in builtins", id)
		}
	}
}

func TestCodexSolTerraLunaSparkModelFields(t *testing.T) {
	tests := []struct {
		id         string
		wantModel  string
		wantEffort string
	}{
		{"codex-sol", "gpt-5.6-sol", "xhigh"},
		{"codex-terra", "gpt-5.6-terra", "xhigh"},
		{"codex-luna", "gpt-5.6-luna", "xhigh"},
		{"codex-spark", "gpt-5.3-codex-spark", "xhigh"},
	}
	for _, tc := range tests {
		p := Get(tc.id)
		if p == nil {
			t.Fatalf("Get(%q) returned nil", tc.id)
		}
		if got := p.Env["CODEX_MODEL"]; got != tc.wantModel {
			t.Errorf("%s CODEX_MODEL = %q, want %q", tc.id, got, tc.wantModel)
		}
		if got := p.Env["CODEX_REASONING_EFFORT"]; got != tc.wantEffort {
			t.Errorf("%s CODEX_REASONING_EFFORT = %q, want %q", tc.id, got, tc.wantEffort)
		}
	}
}

func TestCodebuddyProfiles(t *testing.T) {
	tests := []struct {
		id        string
		wantModel string
	}{
		{"cb-hy", "hunyuan-chat"},
		{"cb-ds", "deepseek-v4-pro"},
		{"cb-dsf", "deepseek-v4-flash"},
		{"cb-kimi", "kimi-k2.6"},
	}
	for _, tc := range tests {
		p := Get(tc.id)
		if p == nil {
			t.Fatalf("Get(%q) returned nil", tc.id)
		}
		if p.Client != "codebuddy" {
			t.Errorf("%s client = %q, want codebuddy", tc.id, p.Client)
		}
		if p.Provider != "codebuddy" {
			t.Errorf("%s provider = %q, want codebuddy", tc.id, p.Provider)
		}
		// Check model in default_args.
		args := p.Launcher["default_args"]
		if args == nil {
			t.Fatalf("%s has no default_args", tc.id)
		}
		found := false
		for _, a := range args.([]any) {
			if s, ok := a.(string); ok && s == tc.wantModel {
				found = true
			}
		}
		if !found {
			t.Errorf("%s default_args does not contain %q: %v", tc.id, tc.wantModel, args)
		}
	}
}

func TestCCKimiProfile(t *testing.T) {
	p := Get("cc-kimi")
	if p == nil {
		t.Fatal("Get(cc-kimi) returned nil")
	}
	if p.Client != "claude" || p.Provider != "kimi-coding" {
		t.Fatalf("cc-kimi client/provider = %s/%s, want claude/kimi-coding", p.Client, p.Provider)
	}
	if p.Env["ANTHROPIC_BASE_URL"] != "https://api.kimi.com/coding/" {
		t.Errorf("cc-kimi ANTHROPIC_BASE_URL = %q, want Claude base https://api.kimi.com/coding/", p.Env["ANTHROPIC_BASE_URL"])
	}
	if p.Env["ANTHROPIC_MODEL"] != "k3[1m]" {
		t.Errorf("cc-kimi ANTHROPIC_MODEL = %q", p.Env["ANTHROPIC_MODEL"])
	}
	if p.Env["CLAUDE_CODE_SUBAGENT_MODEL"] != "k3[1m]" {
		t.Errorf("cc-kimi CLAUDE_CODE_SUBAGENT_MODEL = %q", p.Env["CLAUDE_CODE_SUBAGENT_MODEL"])
	}
	if p.Env["CLAUDE_CODE_AUTO_COMPACT_WINDOW"] != "1048576" {
		t.Errorf("cc-kimi CLAUDE_CODE_AUTO_COMPACT_WINDOW = %q", p.Env["CLAUDE_CODE_AUTO_COMPACT_WINDOW"])
	}
	if p.Env["CLAUDE_CODE_MAX_CONTEXT_TOKENS"] != "1048576" {
		t.Errorf("cc-kimi CLAUDE_CODE_MAX_CONTEXT_TOKENS = %q", p.Env["CLAUDE_CODE_MAX_CONTEXT_TOKENS"])
	}
	if !p.Supports1M {
		t.Error("cc-kimi Supports1M should be true")
	}
}

func TestCCGLMProfile(t *testing.T) {
	p := Get("cc-glm")
	if p == nil {
		t.Fatal("Get(cc-glm) returned nil")
	}
	if p.Client != "claude" || p.Provider != "zhipu-coding" {
		t.Fatalf("cc-glm client/provider = %s/%s, want claude/zhipu-coding", p.Client, p.Provider)
	}
	if p.Env["ANTHROPIC_BASE_URL"] != "https://open.bigmodel.cn/api/anthropic" {
		t.Errorf("cc-glm ANTHROPIC_BASE_URL = %q, want Claude base https://open.bigmodel.cn/api/anthropic", p.Env["ANTHROPIC_BASE_URL"])
	}
	if p.Env["ANTHROPIC_MODEL"] != "glm-5.3" {
		t.Errorf("cc-glm ANTHROPIC_MODEL = %q, want glm-5.3", p.Env["ANTHROPIC_MODEL"])
	}
	if p.Env["CLAUDE_CODE_SUBAGENT_MODEL"] != "glm-5.3" {
		t.Errorf("cc-glm CLAUDE_CODE_SUBAGENT_MODEL = %q, want glm-5.3", p.Env["CLAUDE_CODE_SUBAGENT_MODEL"])
	}
}

func TestBuiltinGrokProfiles(t *testing.T) {
	want := map[string]struct {
		provider string
		model    string
	}{
		"gk-glm":  {provider: "zhipu-coding", model: "forge-zhipu-coding--glm-5-3"},
		"gk-kimi": {provider: "kimi-coding", model: "forge-kimi-coding--k3"},
		"gk-grok": {provider: "xai", model: "grok-4.5"},
	}
	for id, expected := range want {
		profile := Get(id)
		if profile == nil {
			t.Fatalf("Get(%q) returned nil", id)
		}
		if profile.Client != "grok" || profile.Provider != expected.provider || profile.Env["GROK_MODEL"] != expected.model {
			t.Fatalf("%s = client %q provider %q model %q", id, profile.Client, profile.Provider, profile.Env["GROK_MODEL"])
		}
	}
}

func TestDeterministicOrder(t *testing.T) {
	all := List()
	// Sol, Terra, Luna must appear before Spark.
	idxSol := indexOf(all, "codex-sol")
	idxTerra := indexOf(all, "codex-terra")
	idxLuna := indexOf(all, "codex-luna")
	idxSpark := indexOf(all, "codex-spark")

	if idxSol < 0 || idxTerra < 0 || idxLuna < 0 || idxSpark < 0 {
		t.Fatalf("missing core profiles: sol=%d terra=%d luna=%d spark=%d", idxSol, idxTerra, idxLuna, idxSpark)
	}
	if idxSol > idxSpark || idxTerra > idxSpark || idxLuna > idxSpark {
		t.Fatal("Sol, Terra, Luna must come before Spark")
	}
}

func TestImmutableCopy(t *testing.T) {
	// Get should return a copy, not a shared reference.
	p1 := Get("codex-sol")
	p2 := Get("codex-sol")
	if p1 == nil || p2 == nil {
		t.Fatal("Get returned nil")
	}
	// Mutate the copy — should not affect the builtin.
	p1.Env["CODEX_MODEL"] = "mutated"
	p3 := Get("codex-sol")
	if p3.Env["CODEX_MODEL"] == "mutated" {
		t.Fatal("Get should return an immutable copy")
	}

	// BuiltinManifest should also return a copy.
	m1 := BuiltinManifest()
	m1.Profiles["codex-sol"] = Profile{Name: "hijacked"}
	m2 := BuiltinManifest()
	if m2.Profiles["codex-sol"].Name == "hijacked" {
		t.Fatal("BuiltinManifest should return an immutable copy")
	}
}

func TestRemovedProfilesNotFound(t *testing.T) {
	for _, id := range []string{"codex", "codex-high", "codex-xhigh", "codex-lite", "codex-mini", "cb-glm"} {
		p := Get(id)
		if p != nil {
			t.Errorf("Get(%q) should return nil for removed profile", id)
		}
	}
}

func TestActiveProfilesNotDeprecated(t *testing.T) {
	for _, id := range []string{"codex-sol", "codex-terra", "codex-luna", "codex-spark", "cb-hy", "cb-ds", "cb-dsf", "cb-kimi", "cc-kimi", "cc-glm", "gk-glm", "gk-kimi", "gk-grok"} {
		p := Get(id)
		if p == nil {
			t.Fatalf("Get(%q) returned nil", id)
		}
		if p.Deprecated {
			t.Errorf("%s should NOT be deprecated", id)
		}
	}
}

func TestManifestSourcesAreGo(t *testing.T) {
	sources := ManifestSources(LoadDeps{})
	for _, id := range List() {
		if sources[id] != "go" {
			t.Errorf("ManifestSources[%q] = %q, want go", id, sources[id])
		}
	}
}

func indexOf(s []string, target string) int {
	for i, v := range s {
		if v == target {
			return i
		}
	}
	return -1
}
