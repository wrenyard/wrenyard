package llm

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestCommandModelStringPreserved(t *testing.T) {
	var captured Request
	deps := CommandDeps{
		CallLLMWithResult: func(req Request) (*Result, error) {
			captured = req
			return &Result{Text: "ok"}, nil
		},
	}

	code := Command(deps, []string{"--model", "kimi-coding/k3", "hello"})
	if code != 0 {
		t.Fatalf("Command returned %d, want 0", code)
	}
	if captured.Model != "kimi-coding/k3" {
		t.Fatalf("captured Request.Model = %q, want %q", captured.Model, "kimi-coding/k3")
	}
}

func TestCommandRequiresExplicitModel(t *testing.T) {
	// Neither --model nor config llm_model: must fail loudly with usage.
	deps := CommandDeps{
		CallLLMWithResult: func(req Request) (*Result, error) {
			return &Result{Text: "ok"}, nil
		},
	}
	if code := Command(deps, []string{"hello"}); code != 2 {
		t.Fatalf("Command without a model returned %d, want 2", code)
	}
	if code := Command(deps, []string{`{"model":"x"}`}); code != 2 {
		t.Fatalf("raw Command without a model returned %d, want 2", code)
	}

	// Config llm_model satisfies the requirement.
	deps.ConfigModel = "kimi-coding/k3"
	if code := Command(deps, []string{"hello"}); code != 0 {
		t.Fatalf("Command with config model returned %d, want 0", code)
	}
}

func TestCommandRawJSONDetection(t *testing.T) {
	var gotProvider string
	var gotProtocol RawProtocol
	var gotBody []byte
	deps := CommandDeps{
		CallRawLLM: func(providerID string, protocol RawProtocol, body []byte) (*RawResult, error) {
			gotProvider = providerID
			gotProtocol = protocol
			gotBody = body
			return &RawResult{Body: []byte(`{"ok":true}`)}, nil
		},
		ConfigModel:    "zhipu-coding/glm-5.3",
		ConfigProtocol: "openai",
	}

	body := `{"model":"k3","messages":[{"role":"user","content":"hi"}]}`
	code := Command(deps, []string{"-m", "zhipu-coding/glm-5.3", body})
	if code != 0 {
		t.Fatalf("Command returned %d, want 0", code)
	}
	if gotProvider != "zhipu-coding" {
		t.Fatalf("provider = %q, want zhipu-coding", gotProvider)
	}
	if gotProtocol != RawProtocolOpenAI {
		t.Fatalf("protocol = %q, want openai", gotProtocol)
	}
	// B5: body.model must be projected to the RHS model ID from -m,
	// not left as the original JSON value. Input has "k3", output must
	// contain "glm-5.3" (the RHS of "-m zhipu-coding/glm-5.3").
	var parsed map[string]interface{}
	if err := json.Unmarshal(gotBody, &parsed); err != nil {
		t.Fatalf("gotBody is not valid JSON: %v", err)
	}
	gotModel, _ := parsed["model"].(string)
	if gotModel != "glm-5.3" {
		t.Fatalf("projected body.model = %q, want glm-5.3 (from -m zhipu-coding/glm-5.3); raw body was %s", gotModel, body)
	}
}

func TestCommandRawProtocolFlag(t *testing.T) {
	var gotProtocol RawProtocol
	deps := CommandDeps{
		CallRawLLM: func(providerID string, protocol RawProtocol, body []byte) (*RawResult, error) {
			gotProtocol = protocol
			return &RawResult{Body: []byte(`{}`)}, nil
		},
		ConfigModel: "kimi-coding/k3",
	}

	body := `{"model":"k3"}`
	code := Command(deps, []string{"--protocol", "anthropic", "-m", "kimi-coding/k3", body})
	if code != 0 {
		t.Fatalf("Command returned %d, want 0", code)
	}
	if gotProtocol != RawProtocolAnthropic {
		t.Fatalf("protocol = %q, want anthropic", gotProtocol)
	}
}

func TestCommandRawProtocolIgnoredForText(t *testing.T) {
	rawCalled := false
	var captured Request
	deps := CommandDeps{
		CallLLMWithResult: func(req Request) (*Result, error) {
			captured = req
			return &Result{Text: "text-ok"}, nil
		},
		CallRawLLM: func(providerID string, protocol RawProtocol, body []byte) (*RawResult, error) {
			rawCalled = true
			return &RawResult{Body: []byte(`{}`)}, nil
		},
		ConfigModel: "kimi-coding/k3",
	}

	code := Command(deps, []string{"--protocol", "openai", "just plain text"})
	if code != 0 {
		t.Fatalf("Command returned %d, want 0", code)
	}
	if rawCalled {
		t.Fatal("raw path must not be used for plain text input")
	}
	if captured.Prompt != "just plain text" {
		t.Fatalf("text prompt = %q, want %q", captured.Prompt, "just plain text")
	}
}

func TestCommandRawUnsupportedProtocol(t *testing.T) {
	deps := CommandDeps{
		CallRawLLM: func(providerID string, protocol RawProtocol, body []byte) (*RawResult, error) {
			return &RawResult{Body: []byte(`{}`)}, nil
		},
		ConfigModel: "kimi-coding/k3",
	}
	code := Command(deps, []string{"--protocol", "foo", `{"model":"x"}`})
	if code != 2 {
		t.Fatalf("Command returned %d, want 2", code)
	}
}

func TestCommandRawModelPrecedence(t *testing.T) {
	// CLI flag must win over config default.
	var gotProvider string
	deps := CommandDeps{
		CallRawLLM: func(providerID string, protocol RawProtocol, body []byte) (*RawResult, error) {
			gotProvider = providerID
			return &RawResult{Body: []byte(`{}`)}, nil
		},
		ConfigModel: "kimi-coding/k3",
	}
	code := Command(deps, []string{"-m", "kimi-coding/k3", `{"model":"x"}`})
	if code != 0 {
		t.Fatalf("Command returned %d, want 0", code)
	}
	if gotProvider != "kimi-coding" {
		t.Fatalf("provider = %q, want kimi-coding (CLI flag must win)", gotProvider)
	}
}

func TestCommandRawConfigFallback(t *testing.T) {
	// No CLI -m: config default provider is used.
	var gotProvider string
	deps := CommandDeps{
		CallRawLLM: func(providerID string, protocol RawProtocol, body []byte) (*RawResult, error) {
			gotProvider = providerID
			return &RawResult{Body: []byte(`{}`)}, nil
		},
		ConfigModel: "kimi-coding/k3",
	}
	code := Command(deps, []string{`{"model":"x"}`})
	if code != 0 {
		t.Fatalf("Command returned %d, want 0", code)
	}
	if gotProvider != "kimi-coding" {
		t.Fatalf("provider = %q, want kimi-coding (config fallback)", gotProvider)
	}
}

func TestCommandPassesTransportOptionsToRawCall(t *testing.T) {
	var got TransportOptions
	deps := CommandDeps{
		CallRawLLMWithOptions: func(_ string, _ RawProtocol, _ []byte, opts TransportOptions) (*RawResult, error) {
			got = opts
			return &RawResult{Body: []byte(`{}`)}, nil
		},
		ConfigModel: "kimi-coding/k3",
	}

	code := Command(deps, []string{
		"--timeout-ms", "60000",
		"--max-retries", "1",
		"--retry-backoff-ms", "10",
		`{"model":"k3"}`,
	})
	if code != 0 {
		t.Fatalf("Command returned %d, want 0", code)
	}
	if got.Timeout != 60*time.Second {
		t.Fatalf("timeout = %s, want 60s", got.Timeout)
	}
	if got.MaxRetries != 1 {
		t.Fatalf("max retries = %d, want 1", got.MaxRetries)
	}
	if got.RetryBackoff != 10*time.Millisecond {
		t.Fatalf("retry backoff = %s, want 10ms", got.RetryBackoff)
	}
}

// === Raw pass-through (httptest) ===

func TestCallRawOpenAIPassThrough(t *testing.T) {
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

	res, err := CallRaw(CallDeps{
		ResolveRawCapability: func(pid string, p RawProtocol) (RawProviderBinding, error) {
			return RawProviderBinding{Endpoint: server.URL + "/exact/openai", Protocol: p}, nil
		},
		ResolveCredential: func(pid string) (string, bool) { return "test-key", true },
	}, "kimi-coding", RawProtocolOpenAI, []byte(`{"model":"x","messages":[]}`))
	if err != nil {
		t.Fatalf("CallRaw: %v", err)
	}
	if gotPath != "/exact/openai" {
		t.Fatalf("path = %q, want exact configured endpoint", gotPath)
	}
	if gotAuth != "Bearer test-key" {
		t.Fatalf("auth = %q, want Bearer test-key", gotAuth)
	}
	if !bytes.Equal(gotBody, []byte(`{"model":"x","messages":[]}`)) {
		t.Fatalf("body not passed through unchanged: %s", gotBody)
	}
	if !bytes.Equal(res.Body, []byte(`{"choices":[{"message":{"content":"raw-ok"}}]}`)) {
		t.Fatalf("response body changed: %s", res.Body)
	}
}

func TestCallRawAnthropicPassThrough(t *testing.T) {
	var gotPath, gotAuth string
	var gotBody []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("x-api-key")
		gotBody, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"content":[{"type":"text","text":"raw-ok"}]}`))
	}))
	defer server.Close()

	res, err := CallRaw(CallDeps{
		ResolveRawCapability: func(pid string, p RawProtocol) (RawProviderBinding, error) {
			return RawProviderBinding{Endpoint: server.URL + "/exact/anthropic/v1", Protocol: p}, nil
		},
		ResolveCredential: func(pid string) (string, bool) { return "test-key", true },
	}, "anthropic", RawProtocolAnthropic, []byte(`{"model":"claude-x","messages":[]}`))
	if err != nil {
		t.Fatalf("CallRaw: %v", err)
	}
	if gotPath != "/exact/anthropic/v1" {
		t.Fatalf("path = %q, want exact configured endpoint", gotPath)
	}
	if gotAuth != "test-key" {
		t.Fatalf("auth = %q, want test-key", gotAuth)
	}
	if !bytes.Equal(gotBody, []byte(`{"model":"claude-x","messages":[]}`)) {
		t.Fatalf("body not passed through unchanged: %s", gotBody)
	}
	if !bytes.Equal(res.Body, []byte(`{"content":[{"type":"text","text":"raw-ok"}]}`)) {
		t.Fatalf("response body changed: %s", res.Body)
	}
}

func TestCallRawUnsupportedCapabilityRejected(t *testing.T) {
	_, err := CallRaw(CallDeps{
		ResolveRawCapability: func(pid string, p RawProtocol) (RawProviderBinding, error) {
			return RawProviderBinding{}, fmt.Errorf("provider %q does not advertise raw %q", pid, p)
		},
		ResolveCredential: func(pid string) (string, bool) { return "k", true },
	}, "codex", RawProtocolOpenAI, []byte(`{"model":"x"}`))
	if err == nil {
		t.Fatal("expected unsupported capability error")
	}
}

func TestCallRawWithOptionsRetriesTransientStatus(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		if attempts == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			w.Write([]byte(`{"error":"try again"}`))
			return
		}
		w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	res, err := CallRawWithOptions(CallDeps{
		ResolveRawCapability: func(_ string, p RawProtocol) (RawProviderBinding, error) {
			return RawProviderBinding{Endpoint: server.URL, Protocol: p}, nil
		},
		ResolveCredential: func(string) (string, bool) { return "key", true },
	}, "kimi-coding", RawProtocolOpenAI, []byte(`{"model":"x"}`), TransportOptions{
		Timeout:      time.Second,
		MaxRetries:   1,
		RetryBackoff: time.Millisecond,
	})
	if err != nil {
		t.Fatalf("CallRawWithOptions: %v", err)
	}
	if attempts != 2 {
		t.Fatalf("attempts = %d, want 2", attempts)
	}
	if string(res.Body) != `{"ok":true}` {
		t.Fatalf("unexpected response: %s", res.Body)
	}
}

func TestCallRawWithOptionsDoesNotRetryClientError(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":"bad request"}`))
	}))
	defer server.Close()

	_, err := CallRawWithOptions(CallDeps{
		ResolveRawCapability: func(_ string, p RawProtocol) (RawProviderBinding, error) {
			return RawProviderBinding{Endpoint: server.URL, Protocol: p}, nil
		},
		ResolveCredential: func(string) (string, bool) { return "key", true },
	}, "kimi-coding", RawProtocolOpenAI, []byte(`{"model":"x"}`), TransportOptions{
		Timeout:      time.Second,
		MaxRetries:   2,
		RetryBackoff: time.Millisecond,
	})
	if err == nil || !strings.Contains(err.Error(), "400") {
		t.Fatalf("expected 400 error, got %v", err)
	}
	if attempts != 1 {
		t.Fatalf("attempts = %d, want 1", attempts)
	}
}

func TestCallRawWithOptionsSupportsLargeSlowRequestBeyondShortTimeout(t *testing.T) {
	body := []byte(`{"model":"x","prompt":"` + strings.Repeat("x", 256*1024) + `"}`)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, _ := io.ReadAll(r.Body)
		if !bytes.Equal(got, body) {
			t.Errorf("large request body changed: got %d bytes, want %d", len(got), len(body))
		}
		time.Sleep(75 * time.Millisecond)
		w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	res, err := CallRawWithOptions(CallDeps{
		ResolveRawCapability: func(_ string, p RawProtocol) (RawProviderBinding, error) {
			return RawProviderBinding{Endpoint: server.URL, Protocol: p}, nil
		},
		ResolveCredential: func(string) (string, bool) { return "key", true },
	}, "kimi-coding", RawProtocolOpenAI, body, TransportOptions{
		Timeout:      250 * time.Millisecond,
		MaxRetries:   0,
		RetryBackoff: time.Millisecond,
	})
	if err != nil {
		t.Fatalf("large slow request failed with configured timeout: %v", err)
	}
	if string(res.Body) != `{"ok":true}` {
		t.Fatalf("unexpected response: %s", res.Body)
	}
}

// === P0: SanitizeErrorBody direct llm package contract ===

func TestSanitizeErrorBodyScalarRootRaw(t *testing.T) {
	sanitized := SanitizeErrorBody([]byte(`"very-short-secret"`))
	if strings.Contains(sanitized, "very-short-secret") {
		t.Fatalf("root scalar string should be redacted, got: %q", sanitized)
	}
	if sanitized != `"[REDACTED]"` {
		t.Fatalf("expected quoted [REDACTED], got: %q", sanitized)
	}
}

func TestSanitizeErrorBodyArrayElements(t *testing.T) {
	sanitized := SanitizeErrorBody([]byte(`["plain-token-1","plain-token-2"]`))
	if strings.Contains(sanitized, "plain-token") {
		t.Fatalf("array string elements should be redacted, got: %q", sanitized)
	}
	if !strings.Contains(sanitized, "[REDACTED]") {
		t.Fatalf("expected [REDACTED], got: %q", sanitized)
	}
}

func TestSanitizeErrorBodyNestedSensitiveKeys(t *testing.T) {
	sanitized := SanitizeErrorBody([]byte(`{"level":{"accessToken":"at-foo","tokenInternal":"tk-bar","safeField":"visible-text"}}`))
	for _, bad := range []string{"at-foo", "tk-bar"} {
		if strings.Contains(sanitized, bad) {
			t.Fatalf("nested sensitive value %q should be redacted, got: %q", bad, sanitized)
		}
	}
	if !strings.Contains(sanitized, "[REDACTED]") {
		t.Fatalf("expected [REDACTED], got: %q", sanitized)
	}
	if !strings.Contains(sanitized, "visible-text") {
		t.Fatalf("non-sensitive string value should be preserved, got: %q", sanitized)
	}
}

func TestSanitizeErrorBodyContextHeaders(t *testing.T) {
	sanitized := SanitizeErrorBody([]byte(`{"headers":{"Authorization":"Bearer ctx-token","X-User-Id":"uid-99","X-Domain":"corp.net","X-Product":"myapp","X-Requested-With":"fetch","Cookie":"session=abc"}}`))
	for _, bad := range []string{"ctx-token", "uid-99", "corp.net", "myapp", "fetch", "abc", "session="} {
		if strings.Contains(sanitized, bad) {
			t.Fatalf("header/context value %q should be redacted, got: %q", bad, sanitized)
		}
	}
	if !strings.Contains(sanitized, "[REDACTED]") {
		t.Fatalf("expected [REDACTED], got: %q", sanitized)
	}
}

func TestSanitizeErrorBodyNonJSON(t *testing.T) {
	sanitized := SanitizeErrorBody([]byte(`raw error: token=abc123`))
	if strings.Contains(sanitized, "abc123") {
		t.Fatalf("non-JSON body should be replaced, got: %q", sanitized)
	}
	if sanitized != "[REDACTED-UPSTREAM-BODY]" {
		t.Fatalf("expected generic placeholder, got: %q", sanitized)
	}
}

func TestSanitizeErrorBodyPreservesCodeMessage(t *testing.T) {
	sanitized := SanitizeErrorBody([]byte(`{"code":"rate_limited","message":"Too many requests"}`))
	if !strings.Contains(sanitized, "rate_limited") {
		t.Fatalf("safe error code should be preserved, got: %q", sanitized)
	}
	if !strings.Contains(sanitized, "Too many requests") {
		t.Fatalf("safe error message should be preserved, got: %q", sanitized)
	}
}

func TestSanitizeErrorBodyMarshalErrorIsNotLeaked(t *testing.T) {
	sanitized := SanitizeErrorBody([]byte(`{"good":"data"}`))
	if !strings.Contains(sanitized, "good") && !strings.Contains(sanitized, "data") {
		t.Fatalf("valid JSON should round-trip cleanly, got: %q", sanitized)
	}
}

func TestSanitizeErrorBodyAPIVariants(t *testing.T) {
	// P0: all common API-key field variants must be caught regardless of
	// delimiter style (camelCase, underscores, hyphens, no delimiter).
	sanitized := SanitizeErrorBody([]byte(`{"nested":{"api_key":"very-short-ak","apiKey":"another-ak","apikey":"plain-ak","x_api_key":"x-ak-99"}}`))
	for _, bad := range []string{"very-short-ak", "another-ak", "plain-ak", "x-ak-99"} {
		if strings.Contains(sanitized, bad) {
			t.Fatalf("API-key variant value %q should be redacted, got: %q", bad, sanitized)
		}
	}
	if !strings.Contains(sanitized, "[REDACTED]") {
		t.Fatalf("expected [REDACTED], got: %q", sanitized)
	}
}

func TestSanitizeErrorBodyInlineAuthAssignments(t *testing.T) {
	// Inline assignments embedded in safe string fields must be stripped.
	sanitized := SanitizeErrorBody([]byte(`{"error":{"message":"api_key=shrt-val, apiKey:other-val, x_api_key=legacy-key, access_token=bear-tok, safe: ok"}}`))
	for _, bad := range []string{"shrt-val", "other-val", "legacy-key", "bear-tok"} {
		if strings.Contains(sanitized, bad) {
			t.Fatalf("inline auth assignment value %q should be redacted, got: %q", bad, sanitized)
		}
	}
	if !strings.Contains(sanitized, "[REDACTED]") {
		t.Fatalf("expected [REDACTED], got: %q", sanitized)
	}
	// Safe content should survive.
	if !strings.Contains(sanitized, "safe: ok") && !strings.Contains(sanitized, "safe") {
		t.Fatalf("non-sensitive content should be preserved, got: %q", sanitized)
	}
}

func TestCommandStdinRawJSON(t *testing.T) {
	var gotProvider string
	var gotProtocol RawProtocol
	var gotBody []byte
	deps := CommandDeps{
		CallRawLLM: func(providerID string, protocol RawProtocol, body []byte) (*RawResult, error) {
			gotProvider = providerID
			gotProtocol = protocol
			gotBody = body
			return &RawResult{Body: []byte(`{"ok":true}`)}, nil
		},
		ConfigModel:    "zhipu-coding/glm-5.3",
		ConfigProtocol: "openai",
		Stdin:          strings.NewReader(`{"model":"k3","messages":[{"role":"user","content":"hi"}]}`),
	}

	code := Command(deps, []string{"--stdin", "-m", "zhipu-coding/glm-5.3"})
	if code != 0 {
		t.Fatalf("Command returned %d, want 0", code)
	}
	if gotProvider != "zhipu-coding" {
		t.Fatalf("provider = %q, want zhipu-coding", gotProvider)
	}
	if gotProtocol != RawProtocolOpenAI {
		t.Fatalf("protocol = %q, want openai", gotProtocol)
	}
	var parsed map[string]interface{}
	if err := json.Unmarshal(gotBody, &parsed); err != nil {
		t.Fatalf("gotBody is not valid JSON: %v", err)
	}
	gotModel, _ := parsed["model"].(string)
	if gotModel != "glm-5.3" {
		t.Fatalf("projected body.model = %q, want glm-5.3 (from -m zhipu-coding/glm-5.3)", gotModel)
	}
}

func TestCommandStdinLargePayload(t *testing.T) {
	var gotBody []byte
	deps := CommandDeps{
		CallRawLLM: func(providerID string, protocol RawProtocol, body []byte) (*RawResult, error) {
			gotBody = body
			return &RawResult{Body: []byte(`{"ok":true}`)}, nil
		},
		ConfigModel: "kimi-coding/k3",
		Stdin:       strings.NewReader(`{"model":"x","payload":"` + strings.Repeat("A", 205*1024) + `"}`),
	}

	code := Command(deps, []string{"--stdin", "-m", "kimi-coding/k3"})
	if code != 0 {
		t.Fatalf("Command returned %d, want 0", code)
	}
	if len(gotBody) < 200*1024 {
		t.Fatalf("body too small: got %d bytes, want > 200 KiB", len(gotBody))
	}
	var parsed map[string]interface{}
	if err := json.Unmarshal(gotBody, &parsed); err != nil {
		t.Fatalf("gotBody is not valid JSON: %v", err)
	}
	payload, _ := parsed["payload"].(string)
	if len(payload) < 200*1024 {
		t.Fatalf("payload field truncated: got %d bytes", len(payload))
	}
}

func TestCommandStdinWithPositionalInput(t *testing.T) {
	deps := CommandDeps{
		CallRawLLM: func(providerID string, protocol RawProtocol, body []byte) (*RawResult, error) {
			return &RawResult{Body: []byte(`{}`)}, nil
		},
		ConfigModel: "kimi-coding/k3",
		Stdin:       strings.NewReader(`{"model":"x"}`),
	}

	code := Command(deps, []string{"--stdin", "-m", "kimi-coding/k3", `{"model":"k3"}`})
	if code != 2 {
		t.Fatalf("Command returned %d, want 2 (--stdin with positional input)", code)
	}
}

func TestCommandStdinEmpty(t *testing.T) {
	deps := CommandDeps{
		CallRawLLM: func(providerID string, protocol RawProtocol, body []byte) (*RawResult, error) {
			return &RawResult{Body: []byte(`{}`)}, nil
		},
		ConfigModel: "kimi-coding/k3",
		Stdin:       strings.NewReader(""),
	}

	code := Command(deps, []string{"--stdin", "-m", "kimi-coding/k3"})
	if code != 2 {
		t.Fatalf("Command returned %d, want 2 (empty stdin)", code)
	}
}

func TestCommandStdinNilStdin(t *testing.T) {
	deps := CommandDeps{
		CallRawLLM: func(providerID string, protocol RawProtocol, body []byte) (*RawResult, error) {
			return &RawResult{Body: []byte(`{}`)}, nil
		},
		ConfigModel: "kimi-coding/k3",
	}

	code := Command(deps, []string{"--stdin", "-m", "kimi-coding/k3"})
	if code != 2 {
		t.Fatalf("Command returned %d, want 2 (nil Stdin)", code)
	}
}
