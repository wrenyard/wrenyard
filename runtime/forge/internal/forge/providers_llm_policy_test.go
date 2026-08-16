package forge

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/llm"
)

// === LLM Request Construction (httptest) ===

func TestLLMAnthropicRequest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/configured/v1" {
			t.Errorf("expected exact configured path, got %s", r.URL.Path)
		}

		if r.Header.Get("x-api-key") != "test-api-key" {
			t.Errorf("expected x-api-key header, got %v", r.Header.Get("x-api-key"))
		}
		if r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("expected Content-Type: application/json")
		}

		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("parse body: %v", err)
		}

		if body["model"] != "test-model" {
			t.Errorf("expected model test-model, got %v", body["model"])
		}
		if body["system"] != "system prompt" {
			t.Errorf("expected system prompt, got %v", body["system"])
		}
		if body["max_tokens"] == nil {
			t.Error("expected max_tokens in body")
		}

		resp := map[string]interface{}{
			"content": []map[string]interface{}{
				{"type": "text", "text": "Hello from anthropic"},
			},
			"usage": map[string]int{
				"input_tokens":  10,
				"output_tokens": 5,
			},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	result, err := callAnthropic(llm.Provider{
		APIKind: "anthropic",
		BaseURL: server.URL + "/configured/v1",
	}, "test-model", "test-api-key", llmRequest{
		Prompt:    "hello",
		System:    "system prompt",
		MaxTokens: 100,
	})
	if err != nil {
		t.Fatalf("callAnthropic: %v", err)
	}
	if result.Text != "Hello from anthropic" {
		t.Fatalf("expected 'Hello from anthropic', got %q", result.Text)
	}
	if result.Usage == nil || result.Usage.InputTokens != 10 || result.Usage.OutputTokens != 5 {
		t.Fatalf("unexpected usage: %+v", result.Usage)
	}
}

func TestParseProviderModel(t *testing.T) {
	tests := []struct {
		composite   string
		provider    string
		model       string
		expectError bool
	}{
		{"provider/model", "provider", "model", false},
		{"codebuddy/hunyuan-chat", "codebuddy", "hunyuan-chat", false},
		{"invalid", "", "", true},
		{"", "", "", true},
		{"a/b/c", "a", "b/c", false},
	}

	for _, tc := range tests {
		p, m, err := parseProviderModel(tc.composite)
		if tc.expectError && err == nil {
			t.Errorf("expected error for %q", tc.composite)
		}
		if !tc.expectError && err != nil {
			t.Errorf("unexpected error for %q: %v", tc.composite, err)
		}
		if p != tc.provider || m != tc.model {
			t.Errorf("%q: got (%q, %q), want (%q, %q)", tc.composite, p, m, tc.provider, tc.model)
		}
	}
}

func TestLLMAnthropicAPIError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		w.Write([]byte(`{"error":"invalid api key"}`))
	}))
	defer server.Close()

	_, err := callAnthropic(llm.Provider{
		APIKind: "anthropic",
		BaseURL: server.URL,
	}, "model", "bad-key", llmRequest{
		Prompt:    "hello",
		MaxTokens: 100,
	})
	if err == nil {
		t.Fatal("expected error for 401 response")
	}
	if !strings.Contains(err.Error(), "401") {
		t.Fatalf("expected 401 in error, got: %v", err)
	}
}

func TestLLMNoCredential(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)

	_, err := callLLM("zhipu-coding/glm-5.3", "test", "", 100)
	if err == nil {
		t.Fatal("expected no-credential error")
	}
	if !strings.Contains(err.Error(), "no credential") {
		t.Fatalf("expected 'no credential' in error, got: %v", err)
	}
}

func TestSanitizeErrorBodyRedactsAuthHeader(t *testing.T) {
	testAPIKey := "sk-" + "ant-api-03-secret123"
	body := `{"error":{"message":"401 Unauthorized","headers":{"x-api-key":"` + testAPIKey + `","authorization":"Bearer tok-456"}}}`
	sanitized := sanitizeErrorBody([]byte(body))

	if strings.Contains(sanitized, testAPIKey) {
		t.Fatalf("x-api-key value should be redacted, got: %q", sanitized)
	}
	if strings.Contains(sanitized, "tok-456") {
		t.Fatalf("authorization token should be redacted, got: %q", sanitized)
	}
	if !strings.Contains(sanitized, "[REDACTED]") {
		t.Fatalf("expected redaction marker, got: %q", sanitized)
	}
}

func TestSanitizeErrorBodyRedactsLongBase64(t *testing.T) {
	body := `{"error":"data: ` + strings.Repeat("A", 40) + `"}`
	sanitized := sanitizeErrorBody([]byte(body))

	if strings.Contains(sanitized, strings.Repeat("A", 40)) {
		t.Fatalf("long base64 should be redacted, got: %q", sanitized)
	}
	if !strings.Contains(sanitized, "[BASE64_REDACTED]") {
		t.Fatalf("expected base64 redaction marker, got: %q", sanitized)
	}
}

func TestLLMErrorBodyRedactionInError(t *testing.T) {
	testAPIKey := "sk-" + "ant-api-03-deadbeef1234567890abcdef"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		w.Write([]byte(`{"error":"invalid x-api-key: ` + testAPIKey + `"}`))
	}))
	defer server.Close()

	_, err := callAnthropic(llm.Provider{
		APIKind: "anthropic",
		BaseURL: server.URL,
	}, "model", "bad-key", llmRequest{
		Prompt:    "hello",
		MaxTokens: 100,
	})
	if err == nil {
		t.Fatal("expected error for 401 response")
	}
	errStr := err.Error()
	if !strings.Contains(errStr, "401") {
		t.Fatalf("expected 401 in error, got: %v", err)
	}
	if strings.Contains(errStr, "sk-ant-api-03-deadbeef") {
		t.Fatalf("error body contained raw key: %v", err)
	}
	if strings.Contains(errStr, "deadbeef1234567890abcdef") {
		t.Fatalf("error body contained raw base64-like string: %v", err)
	}
}

// === Anthropic Version Header ===

func TestLLMAnthropicVersionHeader(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if v := r.Header.Get("anthropic-version"); v != "2023-06-01" {
			t.Errorf("expected anthropic-version: 2023-06-01, got %q", v)
		}
		resp := map[string]interface{}{
			"content": []map[string]interface{}{{"type": "text", "text": "ok"}},
			"usage":   map[string]int{"input_tokens": 1, "output_tokens": 1},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	_, err := callAnthropic(llm.Provider{APIKind: "anthropic", BaseURL: server.URL}, "test-model", "test-key", llmRequest{
		Prompt:    "hello",
		MaxTokens: 10,
	})
	if err != nil {
		t.Fatalf("callAnthropic: %v", err)
	}
}

// === Credential Availability Gate ===

func TestProfileCredentialAvailableEmptyProvider(t *testing.T) {
	p := profile{Name: "test", Provider: ""}
	if !profileCredentialAvailable(p) {
		t.Fatal("profile with empty provider should be available")
	}
}

func TestProfileCredentialAvailableNoCredential(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)

	p := profile{Name: "test", Provider: "nonexistent-provider"}
	if profileCredentialAvailable(p) {
		t.Fatal("profile with missing credential should NOT be available")
	}
}

func TestProfileCredentialAvailableCodexNative(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)

	// Create Codex auth.json with valid token.
	codexDir := filepath.Join(home, ".codex")
	if err := os.MkdirAll(codexDir, 0o755); err != nil {
		t.Fatal(err)
	}
	codexAuth := map[string]interface{}{
		"tokens": map[string]interface{}{
			"access_token": "codex-auth-token",
		},
	}
	data, _ := json.Marshal(codexAuth)
	if err := os.WriteFile(filepath.Join(codexDir, "auth.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}

	p := profile{Name: "codex-sol", Client: "codex", Provider: "codex"}
	if !profileCredentialAvailable(p) {
		t.Fatal("codex profile should be credential-available with valid Codex auth.json")
	}
}

func TestProfileCredentialAvailableCodexNativeMissing(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)

	p := profile{Name: "codex-sol", Client: "codex", Provider: "codex"}
	if profileCredentialAvailable(p) {
		t.Fatal("codex profile should NOT be credential-available without Codex auth")
	}
}

func TestProfileCredentialAvailableCodexSpark(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)

	// Codex-spark also uses codex auth.
	codexDir := filepath.Join(home, ".codex")
	if err := os.MkdirAll(codexDir, 0o755); err != nil {
		t.Fatal(err)
	}
	codexAuth := map[string]interface{}{
		"tokens": map[string]interface{}{
			"access_token": "codex-spark-token",
		},
	}
	data, _ := json.Marshal(codexAuth)
	if err := os.WriteFile(filepath.Join(codexDir, "auth.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}

	p := profile{Name: "codex-spark", Client: "codex", Provider: "codex-spark"}
	if !profileCredentialAvailable(p) {
		t.Fatal("codex-spark profile should be credential-available with valid Codex auth.json")
	}
}

func TestProfileCredentialAvailableCodebuddyNative(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)

	// Create CodeBuddy auth file with valid token.
	cbDir := codebuddyTestAuthDir(t, home)
	if err := os.MkdirAll(cbDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cbInfo := map[string]interface{}{
		"auth.accessToken": "codebuddy-bearer-token",
		"x-domain":         "tencent.com",
	}
	data, _ := json.Marshal(cbInfo)
	if err := os.WriteFile(filepath.Join(cbDir, "Tencent-Cloud.coding-copilot.info"), data, 0o600); err != nil {
		t.Fatal(err)
	}

	p := profile{Name: "cb-hy", Client: "codebuddy", Provider: "codebuddy"}
	if !profileCredentialAvailable(p) {
		t.Fatal("codebuddy profile should be credential-available with valid CodeBuddy native auth")
	}
}

func TestProfileCredentialAvailableCodebuddyNativeMissing(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)
	_ = codebuddyTestAuthDir(t, home)

	p := profile{Name: "cb-hy", Client: "codebuddy", Provider: "codebuddy"}
	if profileCredentialAvailable(p) {
		t.Fatal("codebuddy profile should NOT be credential-available without CodeBuddy native auth")
	}
}

// === Quota Floor Gate ===

func TestProfileQuotaAvailableNoQuotaProvider(t *testing.T) {
	p := profile{Name: "test"}
	if !profileQuotaAvailable(p, 90) {
		t.Fatal("profile without quota provider should be available")
	}
}

func TestProfileQuotaAvailableNoCacheFile(t *testing.T) {
	p := profile{
		Name: "test",
		Statusline: &statuslineConfig{
			QuotaProvider: "nonexistent-provider",
		},
	}
	if !profileQuotaAvailable(p, 90) {
		t.Fatal("profile with no cache should be available")
	}
}

func TestProfileQuotaAvailableBelowFloor(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)

	quotaDir := filepath.Join(forgeDataDir(), "quota")
	if err := os.MkdirAll(quotaDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	entry := map[string]interface{}{
		"quota": map[string]interface{}{
			"used":  float64(500),
			"total": float64(1000),
		},
		"fetched_at": "2026-01-01T00:00:00Z",
	}
	data, _ := json.Marshal(entry)
	if err := os.WriteFile(filepath.Join(quotaDir, "test-quota.json"), append(data, '\n'), 0o600); err != nil {
		t.Fatalf("write quota cache: %v", err)
	}

	p := profile{
		Name: "test",
		Statusline: &statuslineConfig{
			QuotaProvider: "test-quota",
		},
	}

	if !profileQuotaAvailable(p, 90) {
		t.Fatal("profile with 50% usage should be available with floor=90")
	}
}

func TestProfileQuotaAvailableAboveFloor(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)

	quotaDir := filepath.Join(forgeDataDir(), "quota")
	if err := os.MkdirAll(quotaDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	entry := map[string]interface{}{
		"quota": map[string]interface{}{
			"used":  float64(950),
			"total": float64(1000),
		},
		"fetched_at": "2026-01-01T00:00:00Z",
	}
	data, _ := json.Marshal(entry)
	if err := os.WriteFile(filepath.Join(quotaDir, "zhipu-coding.json"), append(data, '\n'), 0o600); err != nil {
		t.Fatalf("write quota cache: %v", err)
	}

	p := profile{
		Name: "test", Provider: "zhipu-coding",
	}

	if profileQuotaAvailable(p, 90) {
		t.Fatal("profile with 95% usage should NOT be available with floor=90")
	}
}

// === LLM Response Body Size Cap ===

func TestLLMResponseBodyTruncated(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		largeText := strings.Repeat("x", 100)
		resp := map[string]interface{}{
			"content": []map[string]interface{}{{"type": "text", "text": largeText}},
			"usage":   map[string]int{"input_tokens": 1, "output_tokens": 1},
		}
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	_, err := callAnthropic(llm.Provider{APIKind: "anthropic", BaseURL: server.URL}, "test-model", "test-key", llmRequest{
		Prompt:    "hello",
		MaxTokens: 10,
	})
	if err != nil {
		t.Fatalf("callAnthropic with bounded read: %v", err)
	}
}

// === Helpers ===

func setupForgedHome(t *testing.T, home string) {
	t.Helper()
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("XDG_DATA_HOME", filepath.Join(home, ".local", "share"))
	t.Setenv("FORGE_REPO_DIR", t.TempDir())
	_ = os.MkdirAll(filepath.Join(home, ".local", "share", "wrenyard", "runtime"), 0o755)
	_ = os.MkdirAll(filepath.Join(home, ".config", "wrenyard", "runtime"), 0o755)
}

func saveTempConfig(t *testing.T, home string, cfg ForgeConfig) {
	t.Helper()
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("XDG_DATA_HOME", filepath.Join(home, ".local", "share"))
	t.Setenv("FORGE_REPO_DIR", t.TempDir())
	configDir := filepath.Join(home, ".config", "wrenyard", "runtime")
	_ = os.MkdirAll(configDir, 0o755)
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		t.Fatalf("marshal config: %v", err)
	}
	if err := os.WriteFile(filepath.Join(configDir, "config.json"), append(data, '\n'), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}
}

// === Providers describe (capability matrix) ===

func TestProvidersDescribeJSON(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)

	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	oldStdout := os.Stdout
	os.Stdout = w

	code := providersCommand([]string{"describe", "--json"})

	w.Close()
	os.Stdout = oldStdout
	out, _ := io.ReadAll(r)
	if code != 0 {
		t.Fatalf("providers describe --json returned %d; output: %s", code, out)
	}

	var descs []struct {
		ID     string   `json:"id"`
		RawLLM []string `json:"raw_llm"`
	}
	if err := json.Unmarshal(out, &descs); err != nil {
		t.Fatalf("parse describe json: %v\nraw: %s", err, out)
	}

	want := map[string][]string{
		"codebuddy":    nil,
		"codex":        nil,
		"codex-spark":  nil,
		"kimi-coding":  {"openai", "anthropic"},
		"zhipu-coding": {"openai", "anthropic"},
		"anthropic":    {"anthropic"},
	}
	got := map[string][]string{}
	for _, d := range descs {
		got[d.ID] = d.RawLLM
	}
	for id, w := range want {
		g, ok := got[id]
		if !ok {
			t.Fatalf("provider %q missing from describe output", id)
		}
		if !reflect.DeepEqual(g, w) {
			t.Fatalf("provider %q raw_llm = %v, want %v", id, g, w)
		}
	}
}

func TestProvidersDescribeHuman(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)

	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	oldStdout := os.Stdout
	os.Stdout = w

	code := providersCommand([]string{"describe"})

	w.Close()
	os.Stdout = oldStdout
	out, _ := io.ReadAll(r)
	if code != 0 {
		t.Fatalf("providers describe returned %d", code)
	}
	s := string(out)
	for _, id := range []string{"codebuddy", "kimi-coding", "zhipu-coding", "anthropic", "codex"} {
		if !strings.Contains(s, id) {
			t.Fatalf("human describe output missing %q:\n%s", id, s)
		}
	}
	if !strings.Contains(s, "openai") || !strings.Contains(s, "anthropic") {
		t.Fatalf("human describe output missing protocol names:\n%s", s)
	}
}

func TestProvidersListReportsStoredAuthAndKimiLoginReachesAuthFlow(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)
	if err := writeAuth(map[string]AuthEntry{
		"kimi-coding": {Type: "api", Key: "stored-kimi-key"},
	}); err != nil {
		t.Fatal(err)
	}

	out := captureStdout(t, func() {
		if code := providersCommand([]string{"list", "--json"}); code != 0 {
			t.Fatalf("providers list returned %d", code)
		}
	})
	var entries []struct {
		ID     string `json:"id"`
		AuthOK bool   `json:"auth_ok"`
	}
	if err := json.Unmarshal([]byte(out), &entries); err != nil {
		t.Fatalf("parse providers list: %v\n%s", err, out)
	}
	found := false
	for _, entry := range entries {
		if entry.ID == "kimi-coding" {
			found = true
			if !entry.AuthOK {
				t.Fatal("kimi-coding auth_ok should reflect the stored auth.json credential")
			}
		}
	}
	if !found {
		t.Fatal("kimi-coding missing from providers list")
	}

	stderr := captureStderr(t, func() {
		if code := providersCommand([]string{"auth", "login", "kimi-coding"}); code != 1 {
			t.Fatalf("non-TTY providers auth login returned %d, want 1", code)
		}
	})
	if strings.Contains(stderr, "does not support auth") || !strings.Contains(stderr, "TTY") {
		t.Fatalf("kimi login should reach the interactive auth flow, stderr: %s", stderr)
	}
}

func TestProfilesListShowsProfilesAndPoliciesWithoutTarget(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)
	out := captureStdout(t, func() {
		if code := profilesCommand([]string{"list"}); code != 0 {
			t.Fatalf("profiles list returned %d", code)
		}
	})
	if !strings.Contains(out, "Profiles:\n") || !strings.Contains(out, "Policies:\n") {
		t.Fatalf("profiles list should show both sections:\n%s", out)
	}
	if !strings.Contains(out, "general:") {
		t.Fatalf("profiles list should include policies:\n%s", out)
	}
}

func TestProfilesListIncludesAvailableGrokProfiles(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)
	setFakeClientsOnPath(t, "grok")
	setTestAuth(t, "zhipu-coding", "zhipu-test")
	setTestAuth(t, "kimi-coding", "kimi-test")
	oauthPath := filepath.Join(home, ".grok", "auth.json")
	if err := os.MkdirAll(filepath.Dir(oauthPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(oauthPath, []byte(`{"oauth":"opaque"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	out := captureStdout(t, func() {
		if code := profilesCommand([]string{"list", "profile"}); code != 0 {
			t.Fatalf("profiles list profile returned %d", code)
		}
	})
	for _, id := range []string{"gk-glm", "gk-kimi", "gk-grok"} {
		if !strings.Contains(out, id+" (") {
			t.Fatalf("available Grok profile %s missing from list:\n%s", id, out)
		}
	}
}

// === Raw OpenAI / Anthropic response pass-through (no live network) ===

func TestRawOpenAIResponsePassThrough(t *testing.T) {
	var gotPath, gotAuth string
	var gotBody []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotBody, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"choices":[{"message":{"content":"raw-ok"}}]}`))
	}))
	defer server.Close()

	res, err := llm.CallRaw(llm.CallDeps{
		ResolveRawCapability: func(pid string, p llm.RawProtocol) (llm.RawProviderBinding, error) {
			return llm.RawProviderBinding{Endpoint: server.URL + "/configured/v1", Protocol: p}, nil
		},
		ResolveCredential: func(pid string) (string, bool) { return "key", true },
	}, "codebuddy", llm.RawProtocolOpenAI, []byte(`{"model":"x","messages":[]}`))
	if err != nil {
		t.Fatalf("CallRaw: %v", err)
	}
	if gotPath != "/configured/v1" {
		t.Fatalf("path = %q, want exact configured endpoint", gotPath)
	}
	if gotAuth != "Bearer key" {
		t.Fatalf("auth = %q, want Bearer key", gotAuth)
	}
	if string(gotBody) != `{"model":"x","messages":[]}` {
		t.Fatalf("body not passed through unchanged: %s", gotBody)
	}
	if string(res.Body) != `{"choices":[{"message":{"content":"raw-ok"}}]}` {
		t.Fatalf("response body changed: %s", res.Body)
	}
}

func TestRawAnthropicAddsProtocolCredentialHeader(t *testing.T) {
	var gotAPIKey, gotAuthorization, gotContext string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAPIKey = r.Header.Get("x-api-key")
		gotAuthorization = r.Header.Get("Authorization")
		gotContext = r.Header.Get("x-provider-context")
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"content":[]}`))
	}))
	defer server.Close()

	_, err := llm.CallRaw(llm.CallDeps{
		ResolveRawCapability: func(pid string, p llm.RawProtocol) (llm.RawProviderBinding, error) {
			return llm.RawProviderBinding{Endpoint: server.URL, Protocol: p}, nil
		},
		ResolveCredential: func(pid string) (string, bool) { return "anthropic-key", true },
		ResolveHeaders: func(pid string) (http.Header, bool) {
			headers := make(http.Header)
			headers.Set("Authorization", "Bearer generic-key")
			headers.Set("x-provider-context", "preserved")
			return headers, true
		},
	}, "example-provider", llm.RawProtocolAnthropic, []byte(`{"model":"deepseek-v4-pro","messages":[]}`))
	if err != nil {
		t.Fatalf("CallRaw: %v", err)
	}
	if gotAPIKey != "anthropic-key" || gotAuthorization != "Bearer generic-key" || gotContext != "preserved" {
		t.Fatalf("headers = api-key %q authorization %q context %q", gotAPIKey, gotAuthorization, gotContext)
	}
}

// === Codex direct LLM loud failure ===

func TestCodexDirectLLMLoudFailure(t *testing.T) {
	_, err := llm.CallRaw(llm.CallDeps{
		ResolveRawCapability: func(pid string, p llm.RawProtocol) (llm.RawProviderBinding, error) {
			return llm.RawProviderBinding{Endpoint: "http://localhost:1", Protocol: p}, nil
		},
		ResolveCredential: func(pid string) (string, bool) {
			return "some-token", true
		},
	}, "codex", llm.RawProtocolOpenAI, []byte(`{"model":"gpt-5.6-sol","messages":[]}`))
	if err == nil {
		t.Fatal("Codex direct LLM should fail loudly")
	}
	if !strings.Contains(err.Error(), "does not support direct LLM transport") {
		t.Fatalf("expected unsupported-direct-transport error, got: %v", err)
	}
}

func TestCodexSparkDirectLLMLoudFailure(t *testing.T) {
	_, err := llm.CallRaw(llm.CallDeps{
		ResolveRawCapability: func(pid string, p llm.RawProtocol) (llm.RawProviderBinding, error) {
			return llm.RawProviderBinding{Endpoint: "http://localhost:1", Protocol: p}, nil
		},
		ResolveCredential: func(pid string) (string, bool) {
			return "some-token", true
		},
	}, "codex-spark", llm.RawProtocolOpenAI, []byte(`{"model":"gpt-5.3-codex-spark","messages":[]}`))
	if err == nil {
		t.Fatal("Codex-spark direct LLM should fail loudly")
	}
	if !strings.Contains(err.Error(), "does not support direct LLM transport") {
		t.Fatalf("expected unsupported-direct-transport error, got: %v", err)
	}
}

// === B5 raw model projection ===

func TestB5RawModelProjection(t *testing.T) {
	// B5: ParseProviderModel yields providerID and upstream modelID;
	// decode body, replace body.model with RHS modelID, re-encode.
	var gotProvider string
	var gotBody []byte
	deps := llm.CommandDeps{
		CallRawLLM: func(providerID string, protocol llm.RawProtocol, body []byte) (*llm.RawResult, error) {
			gotProvider = providerID
			gotBody = body
			return &llm.RawResult{Body: []byte(`{"ok":true}`)}, nil
		},
		ConfigProtocol: "openai",
	}

	body := `{"model":"original-model","messages":[{"role":"user","content":"hello"}]}`
	code := llm.Command(deps, []string{"-m", "codebuddy/hunyuan-chat", body})
	if code != 0 {
		t.Fatalf("Command returned %d, want 0", code)
	}

	var parsedBody map[string]interface{}
	if err := json.Unmarshal(gotBody, &parsedBody); err != nil {
		t.Fatalf("parse body: %v", err)
	}
	if parsedBody["model"] != "hunyuan-chat" {
		t.Fatalf("body.model = %q, want hunyuan-chat (RHS of provider/model)", parsedBody["model"])
	}
	if gotProvider != "codebuddy" {
		t.Fatalf("providerID = %q, want codebuddy (LHS of provider/model)", gotProvider)
	}
}

func TestB5RawModelProjectionWithWhitespace(t *testing.T) {
	var gotProvider string
	var gotBody []byte
	deps := llm.CommandDeps{
		CallRawLLM: func(providerID string, protocol llm.RawProtocol, body []byte) (*llm.RawResult, error) {
			gotProvider = providerID
			gotBody = body
			return &llm.RawResult{Body: []byte(`{"ok":true}`)}, nil
		},
		ConfigProtocol: "openai",
	}

	// TrimSpace of CLI argv is explicitly allowed.
	body := `{"model":"x","messages":[]}`
	code := llm.Command(deps, []string{"-m", "  codebuddy/hunyuan-chat  ", body})
	if code != 0 {
		t.Fatalf("Command returned %d, want 0", code)
	}

	if gotProvider != "codebuddy" {
		t.Fatalf("providerID = %q, want codebuddy (trimmed)", gotProvider)
	}
	_ = gotBody
}

func TestB5EmptyModelError(t *testing.T) {
	var capturedErr string
	deps := llm.CommandDeps{
		CallRawLLM: func(providerID string, protocol llm.RawProtocol, body []byte) (*llm.RawResult, error) {
			return nil, fmt.Errorf("should not be called")
		},
		ConfigProtocol: "openai",
	}

	body := `{"model":"x","messages":[]}`
	code := llm.Command(deps, []string{"-m", "codebuddy/", body})
	if code != 2 {
		t.Fatalf("Command returned %d, want 2 for empty model", code)
	}
	_ = capturedErr
}

// TestLLMCommandWiresOsStdin is a source-boundary regression test ensuring
// the top-level llm command wires os.Stdin into CommandDeps.
func TestLLMCommandWiresOsStdin(t *testing.T) {
	src, err := os.ReadFile("llm.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(strings.Fields(string(src)), " "), "Stdin: os.Stdin") {
		t.Fatal("llmCommand must wire os.Stdin into CommandDeps; got nil")
	}
}

// === P0: SanitizeErrorBody structured sanitization ===

func TestSanitizeErrorBodyScalarRoot(t *testing.T) {
	body := `"short-secret-value"`
	sanitized := sanitizeErrorBody([]byte(body))
	if strings.Contains(sanitized, "short-secret-value") {
		t.Fatalf("root scalar string should be redacted, got: %q", sanitized)
	}
	if sanitized != `"[REDACTED]"` {
		t.Fatalf("expected quoted [REDACTED], got: %q", sanitized)
	}
}

func TestSanitizeErrorBodyArrayScalar(t *testing.T) {
	body := `["cred1","cred2","harmless text"]`
	sanitized := sanitizeErrorBody([]byte(body))
	if strings.Contains(sanitized, "cred1") || strings.Contains(sanitized, "cred2") || strings.Contains(sanitized, "harmless text") {
		t.Fatalf("array string elements should be redacted, got: %q", sanitized)
	}
	if !strings.Contains(sanitized, "[REDACTED]") {
		t.Fatalf("expected [REDACTED] in output, got: %q", sanitized)
	}
}

func TestSanitizeErrorBodyNestedTokens(t *testing.T) {
	body := `{"data":{"accessToken":"sk-abc","token":"tok-xyz"},"list":[{"accessToken":"inner-key"},"bare-string"],"safe":{"code":200,"message":"ok"}}`
	sanitized := sanitizeErrorBody([]byte(body))
	for _, val := range []string{"sk-abc", "tok-xyz", "inner-key", "bare-string"} {
		if strings.Contains(sanitized, val) {
			t.Fatalf("nested token value %q should be redacted, got: %q", val, sanitized)
		}
	}
	if !strings.Contains(sanitized, `[REDACTED]`) {
		t.Fatalf("expected [REDACTED] in output, got: %q", sanitized)
	}
	if !strings.Contains(sanitized, `"safe"`) {
		t.Fatalf("safe block should be preserved, got: %q", sanitized)
	}
	if !strings.Contains(sanitized, `"code"`) || !strings.Contains(sanitized, `"message"`) {
		t.Fatalf("code and message fields should be preserved, got: %q", sanitized)
	}
}

func TestSanitizeErrorBodyHeaderMapContext(t *testing.T) {
	body := `{"error":{"message":"auth failed","headers":{"Authorization":"Bearer tok-789","X-User-Id":"user-001","X-Enterprise-Id":"ent-002","X-Tenant-Id":"tenant-003","X-Domain":"example.com","X-Product":"forge","X-Requested-With":"XMLHttpRequest"}}}`
	sanitized := sanitizeErrorBody([]byte(body))
	for _, val := range []string{"tok-789", "user-001", "ent-002", "tenant-003", "example.com", "forge", "XMLHttpRequest"} {
		if strings.Contains(sanitized, val) {
			t.Fatalf("header value %q should be redacted, got: %q", val, sanitized)
		}
	}
	if !strings.Contains(sanitized, "[REDACTED]") {
		t.Fatalf("expected [REDACTED] in output, got: %q", sanitized)
	}
	// Safe error message text should still be visible.
	if !strings.Contains(sanitized, "auth failed") {
		t.Fatalf("safe error message should be preserved, got: %q", sanitized)
	}
}

func TestSanitizeErrorBodyNonJSON(t *testing.T) {
	body := `this is not json at all with a short-key=abc123`
	sanitized := sanitizeErrorBody([]byte(body))
	if strings.Contains(sanitized, "abc123") || strings.Contains(sanitized, "short-key") {
		t.Fatalf("non-JSON body should be fully replaced, got: %q", sanitized)
	}
	if sanitized != "[REDACTED-UPSTREAM-BODY]" {
		t.Fatalf("expected generic placeholder, got: %q", sanitized)
	}
}

func TestSanitizeErrorBodyPreservesSafeCodeMessage(t *testing.T) {
	body := `{"error":{"code":"invalid_api_key","message":"The API key provided is invalid"}}`
	sanitized := sanitizeErrorBody([]byte(body))
	if !strings.Contains(sanitized, "invalid_api_key") {
		t.Fatalf("safe error code should be preserved, got: %q", sanitized)
	}
	if !strings.Contains(sanitized, "The API key provided is invalid") {
		t.Fatalf("safe error message should be preserved, got: %q", sanitized)
	}
}

func TestSanitizeErrorBodyEndToEndRawOpenAI(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		w.Write([]byte(`{"error":{"message":"invalid token","headers":{"Authorization":"Bearer sk-fake-token","X-User-Id":"user-123"}}}`))
	}))
	defer server.Close()

	_, err := llm.CallRaw(llm.CallDeps{
		ResolveRawCapability: func(pid string, p llm.RawProtocol) (llm.RawProviderBinding, error) {
			return llm.RawProviderBinding{Endpoint: server.URL, Protocol: p}, nil
		},
		ResolveCredential: func(pid string) (string, bool) { return "test-key", true },
	}, "codebuddy", llm.RawProtocolOpenAI, []byte(`{"model":"x","messages":[]}`))
	if err == nil {
		t.Fatal("expected error for 401 response")
	}
	errStr := err.Error()
	if strings.Contains(errStr, "sk-fake-token") || strings.Contains(errStr, "user-123") {
		t.Fatalf("raw OpenAI error leaked credentials: %v", err)
	}
	if !strings.Contains(errStr, "[REDACTED]") && !strings.Contains(errStr, "[BASE64_REDACTED]") {
		t.Fatalf("expected redaction marker in error: %v", err)
	}
}

func TestSanitizeErrorBodyEndToEndAnthropic(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		w.Write([]byte(`{"error":{"message":"invalid api key","headers":{"x-api-key":"sk-ant-fake","Authorization":"Bearer atok-wxyz"}}}`))
	}))
	defer server.Close()

	_, err := callAnthropic(llm.Provider{
		APIKind: "anthropic",
		BaseURL: server.URL,
	}, "model", "bad-key", llmRequest{
		Prompt:    "hello",
		MaxTokens: 100,
	})
	if err == nil {
		t.Fatal("expected error for 401 response")
	}
	errStr := err.Error()
	if strings.Contains(errStr, "sk-ant-fake") || strings.Contains(errStr, "atok-wxyz") {
		t.Fatalf("Anthropic error leaked credentials: %v", err)
	}
	if !strings.Contains(errStr, "[REDACTED]") && !strings.Contains(errStr, "[BASE64_REDACTED]") {
		t.Fatalf("expected redaction marker in Anthropic error: %v", err)
	}
}

func TestSanitizeErrorBodyEndToEndAPIVariantKeys(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		w.Write([]byte(`{"error":{"message":"auth denied","nested":{"api_key":"shrt-sk","apiKey":"another-sk","apikey":"plain-sk","x_api_key":"x-legacy"}}}`))
	}))
	defer server.Close()

	_, err := llm.CallRaw(llm.CallDeps{
		ResolveRawCapability: func(pid string, p llm.RawProtocol) (llm.RawProviderBinding, error) {
			return llm.RawProviderBinding{Endpoint: server.URL, Protocol: p}, nil
		},
		ResolveCredential: func(pid string) (string, bool) { return "key", true },
	}, "codebuddy", llm.RawProtocolOpenAI, []byte(`{"model":"hunyuan-chat","messages":[]}`))
	if err == nil {
		t.Fatal("expected error for 401 response")
	}
	errStr := err.Error()
	for _, val := range []string{"shrt-sk", "another-sk", "plain-sk", "x-legacy"} {
		if strings.Contains(errStr, val) {
			t.Fatalf("API-key variant %q leaked in error: %v", val, err)
		}
	}
	if !strings.Contains(errStr, "[REDACTED]") && !strings.Contains(errStr, "[BASE64_REDACTED]") {
		t.Fatalf("expected redaction marker in error: %v", err)
	}
}
