package grok

import (
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

func makeProvider(name string, rawOpenAI string, credResolver catalog.CredentialResolver) catalog.Provider {
	p := catalog.Provider{
		Name:               name,
		Kind:               "builtin",
		QuotaProvider:      name,
		SecretResolution:   "none",
		CompatibleDialects: []catalog.Dialect{catalog.DialectGrok},
		Inference: &catalog.InferenceBinding{
			Protocol:           "anthropic-messages",
			Endpoint:           "https://example.invalid",
			CredentialResolver: credResolver,
		},
	}
	if rawOpenAI != "" {
		p.RawLLM = []catalog.RawLLMCapability{
			{Protocol: catalog.RawLLMProtocolOpenAI, BaseEndpoint: rawOpenAI},
		}
	}
	return p
}

func resolveSet(ids ...string) func(string) (string, bool) {
	set := map[string]bool{}
	for _, id := range ids {
		set[id] = true
	}
	return func(id string) (string, bool) {
		if set[id] {
			return "present", true
		}
		return "", false
	}
}

func TestEligibleProjectionMatrix(t *testing.T) {
	cases := []struct {
		name       string
		provider   catalog.Provider
		models     []catalog.ModelDef
		resolveOK  bool
		wantProj   int
		wantSkip   int
		reasonWant string // substring that must appear in a skip reason if wantSkip>0
	}{
		{
			name:      "kimi eligible",
			provider:  makeProvider("kimi-coding", "https://api.kimi.com/coding/v1", catalog.CredentialResolverForgeManaged),
			models:    []catalog.ModelDef{{ID: "k3", DisplayName: "Kimi K3", ContextWindow: 1048576}},
			resolveOK: true,
			wantProj:  1,
		},
		{
			name:     "zhipu eligible",
			provider: makeProvider("zhipu-coding", "https://open.bigmodel.cn/api/coding/paas/v4", catalog.CredentialResolverForgeManaged),
			models: []catalog.ModelDef{
				{ID: "glm-5.3", DisplayName: "GLM-5.3", ContextWindow: 1048576},
			},
			resolveOK: true,
			wantProj:  1,
		},
		{
			name:       "codex no openai raw",
			provider:   makeProvider("codex", "", catalog.CredentialResolver("none")),
			models:     []catalog.ModelDef{{ID: "gpt-5", DisplayName: "GPT-5"}},
			resolveOK:  false,
			wantProj:   0,
			wantSkip:   1,
			reasonWant: "no OpenAI-compatible raw protocol endpoint",
		},
		{
			name:       "non-managed credential resolver excluded",
			provider:   makeProvider("custom", "https://custom.invalid/v1", catalog.CredentialResolver("env")),
			models:     []catalog.ModelDef{{ID: "m1", DisplayName: "M1", ContextWindow: 100}},
			resolveOK:  true,
			wantProj:   0,
			wantSkip:   1,
			reasonWant: "not forge-managed",
		},
		{
			name:       "missing credential skipped at model level",
			provider:   makeProvider("kimi-coding", "https://api.kimi.com/coding/v1", catalog.CredentialResolverForgeManaged),
			models:     []catalog.ModelDef{{ID: "k3", DisplayName: "Kimi K3", ContextWindow: 1048576}},
			resolveOK:  false,
			wantProj:   0,
			wantSkip:   1,
			reasonWant: "no forge-managed credential resolved for provider",
		},
		{
			name:       "missing context window skipped",
			provider:   makeProvider("kimi-coding", "https://api.kimi.com/coding/v1", catalog.CredentialResolverForgeManaged),
			models:     []catalog.ModelDef{{ID: "k3", DisplayName: "Kimi K3"}}, // ContextWindow 0
			resolveOK:  true,
			wantProj:   0,
			wantSkip:   1,
			reasonWant: "no explicit context_window",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resolve := func(string) (string, bool) { return "x", tc.resolveOK }
			proj, skips := projectProvider(tc.provider, tc.models, resolve)
			if len(proj) != tc.wantProj {
				t.Fatalf("projections = %d, want %d (got %+v)", len(proj), tc.wantProj, proj)
			}
			if len(skips) != tc.wantSkip {
				t.Fatalf("skips = %d, want %d (got %+v)", len(skips), tc.wantSkip, skips)
			}
			if tc.reasonWant != "" {
				found := false
				for _, s := range skips {
					if strings.Contains(s.Reason, tc.reasonWant) {
						found = true
					}
				}
				if !found {
					t.Fatalf("expected skip reason containing %q, got %+v", tc.reasonWant, skips)
				}
			}
			// Never leak credential values.
			for _, p := range proj {
				if strings.Contains(p.EnvKey, "OPENAI_API_KEY") || strings.Contains(p.EnvKey, "ANTHROPIC_API_KEY") {
					t.Fatalf("projection must not reuse a generic key name: %s", p.EnvKey)
				}
			}
		})
	}
}

func TestEligibleProjectionsDefaultRegistry(t *testing.T) {
	proj, skips := EligibleProjections(catalog.DefaultRegistry(), resolveSet("kimi-coding", "zhipu-coding"))

	wantIDs := map[string]bool{
		"forge-kimi-coding--k3":       true,
		"forge-zhipu-coding--glm-5-3": true,
	}
	gotIDs := map[string]bool{}
	for _, p := range proj {
		gotIDs[p.ID] = true
	}
	for id := range wantIDs {
		if !gotIDs[id] {
			t.Fatalf("expected eligible projection %q, got %+v", id, gotIDs)
		}
	}
	for id := range gotIDs {
		if !wantIDs[id] {
			t.Fatalf("unexpected projection %q", id)
		}
	}

	// codex/anthropic must be excluded from projections.
	for _, p := range proj {
		if p.ProviderID == "codex" || p.ProviderID == "anthropic" {
			t.Fatalf("provider %q must not be projected", p.ProviderID)
		}
	}

	// Skip reasons must document exclusions deterministically.
	skipReasons := map[string]string{}
	for _, s := range skips {
		skipReasons[s.ProviderID+"/"+s.ModelID] = s.Reason
	}
	if len(skipReasons) == 0 {
		t.Fatalf("expected deterministic skip reasons, got %+v", skips)
	}
}

func TestProjectModelStripsChatCompletionsSuffix(t *testing.T) {
	// Zhipu's RawLLM endpoint is a complete chat/completions URL. The Grok
	// projection must strip the terminal /chat/completions segment so that
	// the chat_completions backend can append the route without doubling it.
	proj := ProjectModel("zhipu-coding",
		"https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
		catalog.ModelDef{ID: "glm-5.3", DisplayName: "GLM-5.3", ContextWindow: 1048576})
	want := "https://open.bigmodel.cn/api/coding/paas/v4"
	if proj.BaseURL != want {
		t.Fatalf("BaseURL = %q, want %q", proj.BaseURL, want)
	}
}

func TestTrimChatCompletionsSuffix(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "trims_terminal_suffix",
			in:   "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
			want: "https://open.bigmodel.cn/api/coding/paas/v4",
		},
		{
			name: "preserves_base_only_endpoint",
			in:   "https://api.kimi.com/coding/v1",
			want: "https://api.kimi.com/coding/v1",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := trimChatCompletionsSuffix(tc.in); got != tc.want {
				t.Fatalf("trimChatCompletionsSuffix(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestModelIDAndEnvKey(t *testing.T) {
	if got := ModelID("kimi-coding", "k3"); got != "forge-kimi-coding--k3" {
		t.Fatalf("ModelID = %q", got)
	}
	if got := ModelID("zhipu-coding", "glm-5.3"); got != "forge-zhipu-coding--glm-5-3" {
		t.Fatalf("ModelID = %q", got)
	}

	if got := EnvKey("kimi-coding"); got != "FORGE_GROK_KIMI_CODING_API_KEY" {
		t.Fatalf("EnvKey(kimi-coding) = %q", got)
	}
	if got := EnvKey("zhipu-coding"); got != "FORGE_GROK_ZHIPU_CODING_API_KEY" {
		t.Fatalf("EnvKey(zhipu-coding) = %q", got)
	}
	if !IsValidEnvKey(EnvKey("kimi-coding")) || !IsValidEnvKey(EnvKey("zhipu-coding")) {
		t.Fatal("generated env keys must be legal env var names")
	}
	if strings.Contains(EnvKey("kimi-coding"), "OPENAI_API_KEY") {
		t.Fatal("env key must not be OPENAI_API_KEY")
	}
}

func TestModelName(t *testing.T) {
	if got := ModelName("kimi-coding", "Kimi K3"); got != "Kimi K3" {
		t.Fatalf("ModelName dedup = %q", got)
	}
	if got := ModelName("zhipu-coding", "GLM-5.3"); got != "Zhipu Coding · GLM-5.3" {
		t.Fatalf("ModelName = %q", got)
	}
}

func TestDefaultPermissionInjection(t *testing.T) {
	// No conflicting flag -> inject default.
	got := WithDefaultPermission([]string{"-p", "hello"})
	if len(got) != 4 || got[0] != "--permission-mode" || got[1] != "bypassPermissions" {
		t.Fatalf("expected default injection, got %+v", got)
	}
	if got[2] != "-p" || got[3] != "hello" {
		t.Fatalf("argv pass-through broken: %+v", got)
	}

	// --permission-mode value form.
	if got := WithDefaultPermission([]string{"--permission-mode", "ask"}); len(got) != 2 {
		t.Fatalf("user permission-mode must not be overridden: %+v", got)
	}
	// --permission-mode=value form.
	if got := WithDefaultPermission([]string{"--permission-mode=bypassPermissions"}); len(got) != 1 {
		t.Fatalf("--permission-mode=value must not be overridden: %+v", got)
	}
	// --always-approve.
	if got := WithDefaultPermission([]string{"--always-approve"}); len(got) != 1 {
		t.Fatalf("--always-approve must not be overridden: %+v", got)
	}
	// --sandbox=value.
	if got := WithDefaultPermission([]string{"--sandbox=docker"}); len(got) != 1 {
		t.Fatalf("--sandbox must not be overridden: %+v", got)
	}
	// --yolo compat spelling.
	if got := WithDefaultPermission([]string{"--yolo"}); len(got) != 1 {
		t.Fatalf("--yolo must not be overridden: %+v", got)
	}
}
