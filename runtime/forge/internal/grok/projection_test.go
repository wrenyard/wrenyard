package grok

import (
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

func TestProjectModelStripsChatCompletionsSuffix(t *testing.T) {
	// The Gateway OpenAI Chat endpoint is a complete chat/completions URL. The Grok
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
	if got := ModelID("zhipu-coding", "glm-5.3-flash"); got != "forge-zhipu-coding--glm-5-3-flash" {
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
