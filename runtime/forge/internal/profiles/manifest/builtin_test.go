package manifest

import (
	"testing"
)

func TestBuiltinProfileSet(t *testing.T) {
	all := List()

	// Verify exact active profiles are present.
	wantActive := map[string]bool{
		"codex-sol":    true,
		"codex-terra":  true,
		"codex-luna":   true,
		"codex-spark":  true,
		"codex-astra":  true,
		"cb-hy":        true,
		"cb-ds":        true,
		"cb-dsf":       true,
		"cb-minimax":   true,
		"cb-kimi":      true,
		"cb-glm":       true,
		"cb-glmf":      true,
		"cc-kimi":      true,
		"cc-glm":       true,
		"cc-glmf":      true,
		"gk-glm":       true,
		"gk-glmf":      true,
		"gk-kimi":      true,
		"gk-grok":      true,
		"cur-composer": true,
		"cur-grok":     true,
		"cur-kimi":     true,
		"cur-opus":     true,
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

func TestCodexAstraProfile(t *testing.T) {
	p := Get("codex-astra")
	if p == nil {
		t.Fatal("Get(codex-astra) returned nil")
	}
	if p.Name != "codex-astra" {
		t.Fatalf("codex-astra name = %q, want codex-astra", p.Name)
	}
	if p.Client != "codex" {
		t.Errorf("codex-astra client = %q, want codex", p.Client)
	}
	if p.Provider != "codex" {
		t.Errorf("codex-astra provider = %q, want codex", p.Provider)
	}
	if p.Env["CODEX_MODEL"] != "gpt-6-astra" {
		t.Errorf("codex-astra CODEX_MODEL = %q, want gpt-6-astra", p.Env["CODEX_MODEL"])
	}
	if p.Env["CODEX_REASONING_EFFORT"] != "xhigh" {
		t.Errorf("codex-astra CODEX_REASONING_EFFORT = %q, want xhigh", p.Env["CODEX_REASONING_EFFORT"])
	}
	if p.Launcher["command"] != "codex" {
		t.Errorf("codex-astra launcher command = %v, want codex", p.Launcher["command"])
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
		{"cb-hy", "hy4-preview"},
		{"cb-ds", "deepseek-v4-pro"},
		{"cb-dsf", "deepseek-v4-flash"},
		{"cb-minimax", "minimax-m3"},
		{"cb-kimi", "kimi-k3"},
		{"cb-glm", "glm-5.3"},
		{"cb-glmf", "glm-5.3-flash"},
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

func TestCCGLMFProfile(t *testing.T) {
	p := Get("cc-glmf")
	if p == nil {
		t.Fatal("Get(cc-glmf) returned nil")
	}
	if p.Client != "claude" || p.Provider != "zhipu-coding" {
		t.Fatalf("cc-glmf client/provider = %s/%s, want claude/zhipu-coding", p.Client, p.Provider)
	}
	if p.Env["ANTHROPIC_BASE_URL"] != "https://open.bigmodel.cn/api/anthropic" {
		t.Errorf("cc-glmf ANTHROPIC_BASE_URL = %q, want Claude base https://open.bigmodel.cn/api/anthropic", p.Env["ANTHROPIC_BASE_URL"])
	}
	if p.Env["ANTHROPIC_MODEL"] != "glm-5.3-flash" {
		t.Errorf("cc-glmf ANTHROPIC_MODEL = %q, want glm-5.3-flash", p.Env["ANTHROPIC_MODEL"])
	}
	if p.Env["CLAUDE_CODE_SUBAGENT_MODEL"] != "glm-5.3-flash" {
		t.Errorf("cc-glmf CLAUDE_CODE_SUBAGENT_MODEL = %q, want glm-5.3-flash", p.Env["CLAUDE_CODE_SUBAGENT_MODEL"])
	}
}

func TestBuiltinGrokProfiles(t *testing.T) {
	want := map[string]struct {
		provider string
		model    string
	}{
		"gk-glm":  {provider: "zhipu-coding", model: "forge-zhipu-coding--glm-5-3"},
		"gk-glmf": {provider: "zhipu-coding", model: "forge-zhipu-coding--glm-5-3-flash"},
		"gk-kimi": {provider: "kimi-coding", model: "forge-kimi-coding--k3"},
		"gk-grok": {provider: "spacex-ai", model: "grok-4.5"},
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

func TestBuiltinCursorProfiles(t *testing.T) {
	want := map[string]struct {
		model    string
		launcher string
	}{
		"cur-composer": {model: "composer-2.5", launcher: "cursor-agent"},
		"cur-grok":     {model: "cursor-grok-4.6-high", launcher: "cursor-agent"},
		"cur-kimi":     {model: "kimi-k3", launcher: "cursor-agent"},
		"cur-opus":     {model: "claude-opus-5", launcher: "cursor-agent"},
	}
	for id, expected := range want {
		profile := Get(id)
		if profile == nil {
			t.Fatalf("Get(%q) returned nil", id)
		}
		if profile.Client != "cursor" || profile.Provider != "cursor" {
			t.Fatalf("%s = client %q provider %q, want cursor/cursor", id, profile.Client, profile.Provider)
		}
		if profile.Env["CURSOR_MODEL"] != expected.model {
			t.Fatalf("%s CURSOR_MODEL = %q, want %q", id, profile.Env["CURSOR_MODEL"], expected.model)
		}
		if profile.Launcher["command"] != expected.launcher {
			t.Fatalf("%s launcher command = %q, want %q", id, profile.Launcher["command"], expected.launcher)
		}
		if len(profile.Settings) != 0 {
			t.Fatalf("%s settings should be empty, got %#v", id, profile.Settings)
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
	for _, id := range []string{"codex", "codex-high", "codex-xhigh", "codex-lite", "codex-mini"} {
		p := Get(id)
		if p != nil {
			t.Errorf("Get(%q) should return nil for removed profile", id)
		}
	}
}

func TestActiveProfilesNotDeprecated(t *testing.T) {
	for _, id := range []string{"codex-sol", "codex-terra", "codex-luna", "codex-spark", "codex-astra", "cb-hy", "cb-ds", "cb-dsf", "cb-minimax", "cb-kimi", "cb-glm", "cb-glmf", "cc-kimi", "cc-glm", "cc-glmf", "gk-glm", "gk-glmf", "gk-kimi", "gk-grok", "cur-composer", "cur-grok", "cur-kimi", "cur-opus"} {
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
