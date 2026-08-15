package forge

import (
	"os"
	"strings"
	"testing"
	"time"

	sl "github.com/wrenyard/wrenyard/runtime/forge/internal/usage/statusline"
)

func TestQuotaProviderForCanonicalNames(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("XDG_DATA_HOME", t.TempDir())

	billing := sl.Billing{DefaultQuotaTotal: 7000}
	tests := []struct {
		name     string
		provider string
		wantName string
	}{
		{name: "codex", provider: "codex", wantName: "codex"},
		{name: "codex-spark", provider: "codex-spark", wantName: "codex-spark"},
		{name: "kimi-coding", provider: "kimi-coding", wantName: "kimi-coding"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			provider := quotaProviderFor(tt.provider, true, true, false, time.Minute, billing)
			if provider == nil {
				t.Fatalf("quotaProviderFor(%q) = nil", tt.provider)
			}
			if got := provider.Name(); got != tt.wantName {
				t.Fatalf("quotaProviderFor(%q).Name() = %q, want %q", tt.provider, got, tt.wantName)
			}
		})
	}
}

func TestProfileQuotaProviderCanonicalNames(t *testing.T) {
	cases := []struct {
		name    string
		profile profile
		want    string
	}{
		{name: "anthropic", profile: profile{Client: "claude", Provider: "anthropic"}, want: ""},
		{name: "explicit anthropic", profile: profile{Statusline: &statuslineConfig{QuotaProvider: "anthropic"}}, want: ""},
		{name: "kimi-coding", profile: profile{Client: "claude", Provider: "kimi-coding"}, want: "kimi-coding"},
		{name: "codex profile", profile: profile{Name: "codex-spark", Client: "codex", Provider: "codex"}, want: "codex"},
		{name: "codex-spark provider", profile: profile{Client: "codex", Provider: "codex-spark"}, want: "codex-spark"},
		{name: "zhipu canonical", profile: profile{Client: "claude", Provider: "zhipu-coding"}, want: "zhipu-coding"},
		{name: "deepseek", profile: profile{Client: "claude", Provider: "deepseek"}, want: ""},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := profileQuotaProviderName(tc.profile); got != tc.want {
				t.Fatalf("profileQuotaProviderName(%+v) = %q, want %q", tc.profile, got, tc.want)
			}
		})
	}
}

func TestOpenCodeQuotaProviderName(t *testing.T) {
	cases := []struct {
		name  string
		input sl.Input
		want  string
	}{
		{
			name:  "kimi canonical provider",
			input: sl.Input{Model: sl.Model{Provider: "kimi-coding", ID: "kimi-coding/k3"}},
			want:  "kimi-coding",
		},
		{
			name:  "kimi for coding has no quota provider",
			input: sl.Input{Model: sl.Model{Provider: "kimi-for-coding", ID: "kimi-for-coding/kimi-k2"}},
			want:  "",
		},
		{
			name:  "deepseek has no quota provider",
			input: sl.Input{Model: sl.Model{Provider: "deepseek", ID: "deepseek/deepseek-v4-pro"}},
			want:  "",
		},
		{
			name:  "openai has no quota provider",
			input: sl.Input{Model: sl.Model{Provider: "openai", ID: "openai/gpt-5"}},
			want:  "",
		},
		{
			name:  "explicit openai ignores codex model prefix",
			input: sl.Input{Model: sl.Model{Provider: "openai", ID: "codex/gpt-5-codex"}},
			want:  "",
		},
		{
			name:  "zhipu exact",
			input: sl.Input{Model: sl.Model{Provider: "zhipu-coding", ID: "zhipu-coding/glm-5.1"}},
			want:  "zhipu-coding",
		},
		{
			name:  "anthropic quota provider",
			input: sl.Input{Model: sl.Model{Provider: "anthropic", ID: "anthropic/claude-sonnet-4-5"}},
			want:  "",
		},
		{
			name:  "model id prefix is not a provider fallback",
			input: sl.Input{Model: sl.Model{ID: "codex/gpt-5-codex"}},
			want:  "",
		},
		{
			name:  "codex spark provider",
			input: sl.Input{Model: sl.Model{Provider: "codex-spark", ID: "codex-spark/gpt-5.3-codex-spark"}},
			want:  "codex-spark",
		},
		{
			name:  "top-level provider id",
			input: sl.Input{ProviderID: "codex", Model: sl.Model{ID: "openai/gpt-5"}},
			want:  "codex",
		},
		{
			name:  "adapted kimi provider id",
			input: sl.Input{Model: sl.Model{ProviderID: "kimi-coding", ID: "kimi-coding/k3"}},
			want:  "kimi-coding",
		},
		{
			name:  "conflicting explicit providers fail closed",
			input: sl.Input{Model: sl.Model{Provider: "kimi-for-coding", ProviderID: "kimi-coding", ID: "kimi-for-coding/kimi-k2"}},
			want:  "",
		},
		{
			name:  "conflicting top-level provider fails closed",
			input: sl.Input{ProviderID: "zhipu-coding", Model: sl.Model{ProviderID: "kimi-coding", ID: "zhipu-coding/glm-5.1"}},
			want:  "",
		},
		{
			name:  "unknown provider",
			input: sl.Input{Model: sl.Model{Provider: "not-a-quota-provider", ID: "not-a-quota-provider/model"}},
			want:  "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := openCodeQuotaProviderName(tc.input); got != tc.want {
				t.Fatalf("provider = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestStatuslineOpenCodeCommandProviderNotFoundOutput(t *testing.T) {
	cases := []struct {
		name  string
		input sl.Input
	}{
		{
			name:  "missing provider",
			input: sl.Input{Model: sl.Model{ID: "codex/gpt-5-codex"}},
		},
		{
			name:  "unsupported provider",
			input: sl.Input{Model: sl.Model{Provider: "not-a-quota-provider", ID: "not-a-quota-provider/model"}},
		},
		{
			name:  "conflicting providers",
			input: sl.Input{ProviderID: "zhipu-coding", Model: sl.Model{ProviderID: "kimi-coding"}},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out := captureOpenCodeStatuslineStdout(t, func() {
				statuslineOpenCodeCommand(tc.input, sl.Billing{}, ForgeConfig{})
			})
			if strings.TrimSpace(out) != openCodeProviderNotFound {
				t.Fatalf("output = %q, want %q", out, openCodeProviderNotFound)
			}
		})
	}
}

func captureOpenCodeStatuslineStdout(t *testing.T, fn func()) string {
	t.Helper()

	old := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()

	os.Stdout = w
	defer func() {
		os.Stdout = old
	}()

	done := make(chan string, 1)
	go func() {
		data, _ := readAll(r)
		done <- string(data)
	}()

	fn()
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return <-done
}

func readAll(r *os.File) ([]byte, error) {
	var buf []byte
	tmp := make([]byte, 1024)
	for {
		n, err := r.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
		}
		if err != nil {
			if err.Error() == "EOF" {
				break
			}
			return buf, err
		}
	}
	return buf, nil
}
