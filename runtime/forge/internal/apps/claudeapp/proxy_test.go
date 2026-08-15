package claudeapp

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestProxyUsesUpstreamResponseHeaderTimeout(t *testing.T) {
	proxy, ok := NewProxy(Config{}).(*Proxy)
	if !ok {
		t.Fatalf("expected *Proxy")
	}
	transport, ok := proxy.client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("expected proxy HTTP client to use *http.Transport, got %T", proxy.client.Transport)
	}
	if transport.ResponseHeaderTimeout <= 0 {
		t.Fatalf("expected upstream response header timeout to be configured")
	}
}

func TestProxyMapsModelAndAuth(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/messages" {
			t.Fatalf("unexpected upstream path: %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer upstream-token" {
			t.Fatalf("unexpected upstream Authorization: %s", got)
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		payload := map[string]interface{}{}
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatal(err)
		}
		if payload["model"] != "glm-5.3" {
			t.Fatalf("expected upstream model glm-5.3, got %#v", payload["model"])
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"glm-5.3","stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}`))
	}))
	defer upstream.Close()

	cfg := Config{
		Profile:         Profile{Name: "ccg", Provider: "glm"},
		GatewayAPIKey:   "gateway-token",
		UpstreamBaseURL: upstream.URL + "/v1/messages",
		UpstreamToken:   "upstream-token",
		Routes: []ModelRoute{
			{Name: sonnetID, DisplayName: sonnetID, Slot: "sonnet", UpstreamModel: "glm-5.3"},
		},
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(`{"model":"`+sonnetID+`","max_tokens":1,"messages":[]}`))
	req.Header.Set("Authorization", "Bearer gateway-token")
	rec := httptest.NewRecorder()

	NewProxy(cfg).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 from proxy, got %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"model":"`+sonnetID+`"`) {
		t.Fatalf("proxy response should normalize model back to route id: %s", rec.Body.String())
	}
}

func TestProxyNormalizesStreamModel(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("event:message_start\n"))
		_, _ = w.Write([]byte(`data:{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"glm-5.3","usage":{"input_tokens":1}}}` + "\n\n"))
		_, _ = w.Write([]byte("event:message_stop\n"))
		_, _ = w.Write([]byte(`data:{"type":"message_stop"}` + "\n\n"))
	}))
	defer upstream.Close()

	cfg := Config{
		Profile:         Profile{Name: "ccg", Provider: "glm"},
		GatewayAPIKey:   "gateway-token",
		UpstreamBaseURL: upstream.URL,
		UpstreamToken:   "upstream-token",
		Routes: []ModelRoute{
			{Name: sonnetID, DisplayName: sonnetID, Slot: "sonnet", UpstreamModel: "glm-5.3"},
		},
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(`{"model":"`+sonnetID+`","max_tokens":1,"stream":true,"messages":[]}`))
	req.Header.Set("Authorization", "Bearer gateway-token")
	rec := httptest.NewRecorder()

	NewProxy(cfg).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 from stream proxy, got %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `event: message_start`) {
		t.Fatalf("stream proxy should canonicalize event lines: %s", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"model":"`+sonnetID+`"`) {
		t.Fatalf("stream proxy should normalize model back to route id: %s", rec.Body.String())
	}
}

func TestProxyMapsNativeClaudePublicIDToVendorModel(t *testing.T) {
	cfg := Config{
		Routes: []ModelRoute{
			{Name: opusID, DisplayName: "Opus 4.6", Slot: "opus", UpstreamModel: "claude-opus-4.6"},
			{Name: sonnetID, DisplayName: "Vendor Sonnet 2", Slot: "sonnet", UpstreamModel: "vendor-sonnet-v2"},
		},
	}
	proxy := &Proxy{cfg: cfg}

	if got := proxy.mapModel(opusID); got != "claude-opus-4.6" {
		t.Fatalf("native Claude public ID should map to provider upstream ID, got %q", got)
	}
	if got := proxy.mapModel(sonnetID); got != "vendor-sonnet-v2" {
		t.Fatalf("native Claude sonnet slot should map to provider upstream ID, got %q", got)
	}
	if got := proxy.mapModel("vendor-sonnet-v2"); got != "vendor-sonnet-v2" {
		t.Fatalf("non-Claude model IDs should forward unchanged, got %q", got)
	}
}

func TestProxyMapModelResolvesSlotAndUnknown(t *testing.T) {
	cfg := Config{Routes: []ModelRoute{
		{Name: opusID, DisplayName: "Opus", Slot: "opus", UpstreamModel: "claude-opus-4.8"},
		{Name: sonnetID, DisplayName: "Sonnet", Slot: "sonnet", UpstreamModel: "provider-sonnet"},
		{Name: haikuID, DisplayName: "Haiku", Slot: "haiku", UpstreamModel: "provider-haiku"},
	}}
	proxy := &Proxy{cfg: cfg}
	if got := proxy.mapModel(sonnetID); got != "provider-sonnet" {
		t.Fatalf("mapModel by route id should map to upstream, got %q", got)
	}
	if got := proxy.mapModel("provider-sonnet"); got != "provider-sonnet" {
		t.Fatalf("mapModel by upstream should forward, got %q", got)
	}
	if got := proxy.mapModel("opus"); got != "claude-opus-4.8" {
		t.Fatalf("mapModel by opus slot should map to opus upstream, got %q", got)
	}
	if got := proxy.mapModel("mystery-model"); got != "mystery-model" {
		t.Fatalf("mapModel of unknown model should forward unchanged, got %q", got)
	}
	if got := proxy.mapModel(""); got != "" {
		t.Fatalf("mapModel of empty input should be empty, got %q", got)
	}
}

func TestProxyMapModelEmptyReturnsEmpty(t *testing.T) {
	proxy := &Proxy{cfg: Config{}}
	if got := proxy.mapModel("   "); got != "" {
		t.Fatalf("whitespace model should map to empty, got %q", got)
	}
}

func TestProxyMapsUpstreamRequestHeadersAndForwardedModel(t *testing.T) {
	var gotAuth, gotUA, gotVersion, gotBeta, gotAccept string
	var gotBody map[string]interface{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotUA = r.Header.Get("User-Agent")
		gotVersion = r.Header.Get("anthropic-version")
		gotBeta = r.Header.Get("anthropic-beta")
		gotAccept = r.Header.Get("Accept")
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &gotBody)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"provider-sonnet","usage":{"input_tokens":1,"output_tokens":1}}`))
	}))
	defer upstream.Close()

	cfg := Config{
		Profile:         Profile{Name: "ccg", Provider: "glm"},
		GatewayAPIKey:   "gateway-token",
		UpstreamBaseURL: upstream.URL,
		UpstreamToken:   "upstream-secret",
		Routes: []ModelRoute{
			{Name: sonnetID, DisplayName: sonnetID, Slot: "sonnet", UpstreamModel: "provider-sonnet"},
		},
	}
	reqBody := `{"model":"` + sonnetID + `","max_tokens":10,"messages":[],"stream":false}`
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(reqBody))
	req.Header.Set("Authorization", "Bearer gateway-token")
	req.Header.Set("anthropic-version", "2023-06-01")
	req.Header.Set("anthropic-beta", "some-beta")
	rec := httptest.NewRecorder()

	NewProxy(cfg).ServeHTTP(rec, req)

	if gotAuth != "Bearer upstream-secret" {
		t.Fatalf("upstream Authorization = %q, want Bearer upstream-secret", gotAuth)
	}
	if gotUA != "forge-claude-app-gateway/1" {
		t.Fatalf("upstream User-Agent = %q, want forge-claude-app-gateway/1", gotUA)
	}
	if gotVersion != "2023-06-01" {
		t.Fatalf("upstream anthropic-version = %q, want 2023-06-01", gotVersion)
	}
	if gotBeta != "some-beta" {
		t.Fatalf("upstream anthropic-beta = %q, want some-beta", gotBeta)
	}
	if gotAccept != "application/json" {
		t.Fatalf("upstream Accept for non-streaming should be application/json, got %q", gotAccept)
	}
	if gotBody["model"] != "provider-sonnet" {
		t.Fatalf("outbound model = %#v, want provider-sonnet", gotBody["model"])
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestProxyRejectsUnauthorizedMessages(t *testing.T) {
	cfg := Config{GatewayAPIKey: "gateway-token"}
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(`{"model":"x","messages":[]}`))
	rec := httptest.NewRecorder()
	NewProxy(cfg).ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without valid token, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "invalid Forge Claude app gateway key") {
		t.Fatalf("expected unauthorized error body, got %s", rec.Body.String())
	}
}

func TestProxyHealthRespondsToRootAndHealth(t *testing.T) {
	cfg := Config{Profile: Profile{Name: "ccg", Provider: "glm"}, GatewayBaseURL: "http://127.0.0.1:18080"}
	proxy := NewProxy(cfg)
	for _, path := range []string{"/", "/health", "/status"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		proxy.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s expected 200, got %d", path, rec.Code)
		}
		resp := map[string]interface{}{}
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("GET %s response not JSON: %v", path, err)
		}
		if resp["status"] != "ok" || resp["profile"] != "ccg" || resp["provider"] != "glm" {
			t.Fatalf("GET %s health payload mismatch: %#v", path, resp)
		}
	}
}

func TestProxyAcceptsStaticAndDesktopOAuthTokens(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	credsDir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(credsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	creds := `{"claudeAiOauth":{"accessToken":"desktop-oauth-token","refreshToken":"refresh-ignored"}}`
	if err := os.WriteFile(filepath.Join(credsDir, ".credentials.json"), []byte(creds), 0o600); err != nil {
		t.Fatal(err)
	}
	proxy := &Proxy{cfg: Config{GatewayAPIKey: "forge-token"}}
	for name, headers := range map[string]map[string]string{
		"bearer static":     {"Authorization": "Bearer forge-token"},
		"x api key":         {"x-api-key": "forge-token"},
		"anthropic api key": {"Anthropic-Api-Key": "forge-token"},
		"desktop oauth":     {"Authorization": "Bearer desktop-oauth-token"},
	} {
		req := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
		for key, value := range headers {
			req.Header.Set(key, value)
		}
		if !proxy.authorized(req) {
			t.Fatalf("%s token should be accepted", name)
		}
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	req.Header.Set("Authorization", "Bearer refresh-ignored")
	if proxy.authorized(req) {
		t.Fatal("refresh token should not be accepted")
	}
}

func TestProxyRequestedSlotUnknownModelDefaultsToEmpty(t *testing.T) {
	cfg := Config{Routes: []ModelRoute{
		{Name: sonnetID, Slot: "sonnet", UpstreamModel: "provider-sonnet"},
	}}
	proxy := &Proxy{cfg: cfg}
	if got := proxy.mapModel("totally-unknown-provider"); got != "totally-unknown-provider" {
		t.Fatalf("unknown model should forward unchanged, got %q", got)
	}
}
