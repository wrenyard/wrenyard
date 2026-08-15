package claudeapp

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestRoutesFromProfileUseModelEnv(t *testing.T) {
	routes := routesFromProfile(Profile{Env: map[string]string{
		"ANTHROPIC_DEFAULT_OPUS_MODEL":   "opus-model",
		"ANTHROPIC_DEFAULT_SONNET_MODEL": "sonnet-model",
		"ANTHROPIC_DEFAULT_HAIKU_MODEL":  "haiku-model",
	}}, nil, "", nil)
	if len(routes) != 3 {
		t.Fatalf("expected 3 Claude app routes, got %d", len(routes))
	}
	for _, route := range routes {
		switch route.Slot {
		case "opus":
			if route.UpstreamModel != "opus-model" {
				t.Fatalf("route %s should map to opus-model, got %s", route.Name, route.UpstreamModel)
			}
		case "sonnet":
			if route.UpstreamModel != "sonnet-model" {
				t.Fatalf("route %s should map to sonnet-model, got %s", route.Name, route.UpstreamModel)
			}
		case "haiku":
			if route.UpstreamModel != "haiku-model" {
				t.Fatalf("route %s should map to haiku-model, got %s", route.Name, route.UpstreamModel)
			}
		default:
			t.Fatalf("unexpected route slot %q for %q", route.Slot, route.Name)
		}
	}
	if routes[0].Name != opusID || routes[1].Name != sonnetID || routes[2].Name != haikuID {
		t.Fatalf("unexpected route order: %#v", routes)
	}
}

func TestRoutesFromProfileFallsBackToModelOverrides(t *testing.T) {
	routes := routesFromProfile(Profile{
		Env: map[string]string{},
		Settings: map[string]interface{}{
			"modelOverrides": map[string]interface{}{
				"claude-opus-4-8":   "glm-5.3",
				"claude-sonnet-4-6": "glm-5.3",
				"claude-haiku-4-5":  "glm-5.2",
			},
		},
	}, map[string]string{
		"claude-opus-4-8":   "glm-5.3",
		"claude-sonnet-4-6": "glm-5.3",
		"claude-haiku-4-5":  "glm-5.2",
	}, "", nil)
	if len(routes) != 3 {
		t.Fatalf("expected 3 Claude app routes from modelOverrides, got %d: %#v", len(routes), routes)
	}
	want := map[string]string{
		"opus":   "glm-5.3",
		"sonnet": "glm-5.3",
		"haiku":  "glm-5.2",
	}
	wantNames := map[string]string{
		"opus":   "GLM 5.3",
		"sonnet": "GLM 5.3",
		"haiku":  "GLM 5.2",
	}
	for _, route := range routes {
		if route.UpstreamModel != want[route.Slot] {
			t.Fatalf("route %s upstream = %q, want %q: %#v", route.Slot, route.UpstreamModel, want[route.Slot], routes)
		}
		if route.DisplayName != wantNames[route.Slot] {
			t.Fatalf("route %s display name = %q, want %q: %#v", route.Slot, route.DisplayName, wantNames[route.Slot], routes)
		}
	}
}

func TestRoutesFromProfileUseConfiguredDisplayNames(t *testing.T) {
	routes := routesFromProfile(Profile{Env: map[string]string{
		"ANTHROPIC_DEFAULT_OPUS_MODEL":              "provider-opus-model",
		"ANTHROPIC_DEFAULT_SONNET_MODEL":            "provider-sonnet-model",
		"ANTHROPIC_DEFAULT_HAIKU_MODEL":             "provider-haiku-model",
		"ANTHROPIC_DEFAULT_OPUS_MODEL_NAME":         "Provider Opus",
		"ANTHROPIC_DEFAULT_SONNET_MODEL_NAME":       "Provider Sonnet",
		"ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME":        "Provider Haiku",
		"ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION": "Creative fast model",
	}}, nil, "", nil)
	if len(routes) != 3 {
		t.Fatalf("expected 3 Claude app routes, got %d", len(routes))
	}
	want := []struct {
		name         string
		displayName  string
		upstreamName string
	}{
		{opusID, "Provider Opus", "provider-opus-model"},
		{sonnetID, "Provider Sonnet", "provider-sonnet-model"},
		{haikuID, "Provider Haiku", "provider-haiku-model"},
	}
	for i, route := range routes {
		if route.Name != want[i].name || route.DisplayName != want[i].displayName || route.UpstreamModel != want[i].upstreamName {
			t.Fatalf("route %d mismatch: got %#v, want %#v", i, route, want[i])
		}
	}
	models := localModelEntries(routes)
	for i, model := range models {
		if model["labelOverride"] != want[i].displayName {
			t.Fatalf("model %d labelOverride mismatch: got %#v, want %q", i, model, want[i].displayName)
		}
		if _, ok := model["displayName"]; ok {
			t.Fatalf("static inferenceModels should not use unsupported displayName field: %#v", model)
		}
	}
}

func TestRoutesFromProfileFallsBackToSlotNamesWhenAliasNotProvided(t *testing.T) {
	routes := routesFromProfile(Profile{Env: map[string]string{
		"ANTHROPIC_DEFAULT_OPUS_MODEL":   "provider-opus-model",
		"ANTHROPIC_DEFAULT_SONNET_MODEL": "provider-sonnet-model",
		"ANTHROPIC_DEFAULT_HAIKU_MODEL":  "provider-haiku-model",
	}}, nil, "", nil)
	if len(routes) != 3 {
		t.Fatalf("expected 3 Claude app routes, got %d", len(routes))
	}
	for _, route := range routes {
		if route.DisplayName != route.Name {
			t.Fatalf("route display name should default to slot name when no friendly alias is set: got %q", route.DisplayName)
		}
	}
}

func TestRoutesFromProfileUseProviderOwnedDisplayName(t *testing.T) {
	routes := routesFromProfile(
		Profile{Provider: "kimi-coding", Env: map[string]string{}},
		map[string]string{
			"claude-opus-4-8":   "k3",
			"claude-sonnet-4-6": "k3",
			"claude-haiku-4-5":  "k3",
		},
		"",
		func(providerID, modelID string) string {
			if providerID == "kimi-coding" && modelID == "k3" {
				return "Kimi K3"
			}
			return ""
		},
	)
	if len(routes) != 3 {
		t.Fatalf("expected 3 K3 routes, got %d: %#v", len(routes), routes)
	}
	for _, route := range routes {
		if route.DisplayName != "Kimi K3" || route.LabelOverride != "Kimi K3" {
			t.Fatalf("provider-owned display name not applied: %#v", route)
		}
	}
	models := localModelEntries(routes)
	for _, model := range models {
		if model["labelOverride"] != "Kimi K3" {
			t.Fatalf("K3 policy labelOverride = %#v, want Kimi K3", model["labelOverride"])
		}
	}
}

func TestPolicyModelsIncludeLabelOverride(t *testing.T) {
	models, err := policyModels([]ModelRoute{
		{Name: sonnetID, DisplayName: "GLM 5.3", UpstreamModel: "glm-5.3"},
	})
	if err != nil {
		t.Fatal(err)
	}
	var decoded []map[string]interface{}
	if err := json.Unmarshal([]byte(models), &decoded); err != nil {
		t.Fatal(err)
	}
	if got := decoded[0]["labelOverride"]; got != "GLM 5.3" {
		t.Fatalf("expected policy model labelOverride to be configurable alias, got %#v in %s", got, models)
	}
}

func TestPolicyValuesIncludeGatewayHeader(t *testing.T) {
	values := policyValues(Config{GatewayAPIKey: "forge-token"}, "[]")
	for _, value := range values {
		if value.name == "inferenceGatewayHeaders" {
			if value.value != `{"x-api-key":"forge-token"}` {
				t.Fatalf("expected registry gateway headers to include x-api-key, got %q", value.value)
			}
			return
		}
	}
	t.Fatal("missing inferenceGatewayHeaders policy value")
}

func TestRequestedSlotFromKnownAndVendorModels(t *testing.T) {
	cases := map[string]string{
		opusID:                 "opus",
		"claude-opus-4-7":      "opus",
		"claude-opus-4-6":      "opus",
		"anything-with-opus":   "opus",
		sonnetID:               "sonnet",
		"claude-sonnet-4-5":    "sonnet",
		"anything-sonnet-here": "sonnet",
		haikuID:                "haiku",
		"contains-haiku-model": "haiku",
		"glm-5.3":              "",
		"":                     "",
	}
	for input, want := range cases {
		if got := requestedSlot(input); got != want {
			t.Fatalf("requestedSlot(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestPublicModelIDConvertsClaudeProviderIDsGenerically(t *testing.T) {
	cases := []struct {
		route ModelRoute
		want  string
	}{
		{route: ModelRoute{UpstreamModel: "claude-opus-4.8-1m"}, want: "claude-opus-4-8[1m]"},
		{route: ModelRoute{UpstreamModel: "claude-sonnet-4.6-1m"}, want: "claude-sonnet-4-6[1m]"},
		{route: ModelRoute{UpstreamModel: "claude-haiku-4.5"}, want: haikuID},
		{route: ModelRoute{Name: sonnetID, UpstreamModel: "glm-5.3[1m]", Supports1M: true}, want: sonnetID + "[1m]"},
	}
	for _, tc := range cases {
		if got := publicModelID(tc.route); got != tc.want {
			t.Fatalf("publicModelID(%q) = %q, want %q", tc.route.UpstreamModel, got, tc.want)
		}
	}
}

func TestGatewayPathAcceptsLegacyPrefix(t *testing.T) {
	cases := map[string]string{
		"/claude-desktop":                          "/",
		"/claude-desktop/v1/messages":              "/v1/messages",
		"/claude-desktop/v1/messages/count_tokens": "/v1/messages/count_tokens",
		"/v1/models":                               "/v1/models",
	}
	for input, want := range cases {
		if got := gatewayPath(input); got != want {
			t.Fatalf("gatewayPath(%q): expected %q, got %q", input, want, got)
		}
	}
}

func TestGatewayHeadersJSONShape(t *testing.T) {
	if got := GatewayHeadersJSON("forge-token"); got != `{"x-api-key":"forge-token"}` {
		t.Fatalf("GatewayHeadersJSON = %q, want {\"x-api-key\":\"forge-token\"}", got)
	}
	if got := gatewayHeaders("x"); got["x-api-key"] != "x" {
		t.Fatalf("gatewayHeaders should include x-api-key, got %#v", got)
	}
}

func TestShouldRetryElevatedForRegAddFailure(t *testing.T) {
	err := errorString("forge app: reg add inferenceProvider failed: localized registry failure")
	if !shouldRetryElevated(err) {
		t.Fatal("expected Claude app policy reg add failure to retry elevated")
	}
}

func TestBuildUpstreamURL(t *testing.T) {
	cases := map[string]string{
		" https://open.bigmodel.cn/api/anthropic ":  "https://open.bigmodel.cn/api/anthropic",
		"https://open.bigmodel.cn/api/anthropic/v1": "https://open.bigmodel.cn/api/anthropic/v1",
	}
	for input, want := range cases {
		if got := buildUpstreamURL(input); got != want {
			t.Fatalf("buildUpstreamURL(%q): expected %q, got %q", input, want, got)
		}
	}
}

func TestProxyPIDsFromPSOutput(t *testing.T) {
  output := `
  101 /opt/wrenyard/bin/forge app use ccg --port 18080 --forge-serve-proxy
  202 /bin/zsh -lc ps -axo pid=,command= | rg '--forge-serve-proxy'
  303 /opt/wrenyard/bin/forge app use cb-ds --port 18081 --forge-serve-proxy
  404 /opt/homebrew/bin/node something-else
`
	pids := proxyPIDsFromPS(output, 303)
	if !reflect.DeepEqual(pids, []int{101}) {
		t.Fatalf("unexpected proxy PIDs: %#v", pids)
	}
}

func TestRoutesFromProfilePrecedenceEnvOverrideProviderDefault(t *testing.T) {
	routes := routesFromProfile(
		Profile{Env: map[string]string{
			"ANTHROPIC_DEFAULT_OPUS_MODEL": "env-opus",
		}},
		map[string]string{
			"claude-sonnet-4-6": "override-sonnet",
		},
		"default-haiku",
		nil,
	)
	if len(routes) != 3 {
		t.Fatalf("expected 3 routes, got %d: %#v", len(routes), routes)
	}
	for _, route := range routes {
		switch route.Slot {
		case "opus":
			if route.UpstreamModel != "env-opus" {
				t.Fatalf("env should take precedence for opus: got %q, want %q", route.UpstreamModel, "env-opus")
			}
		case "sonnet":
			if route.UpstreamModel != "override-sonnet" {
				t.Fatalf("modelOverrides should take precedence for sonnet: got %q, want %q", route.UpstreamModel, "override-sonnet")
			}
		case "haiku":
			if route.UpstreamModel != "default-haiku" {
				t.Fatalf("provider default should fill haiku: got %q, want %q", route.UpstreamModel, "default-haiku")
			}
		default:
			t.Fatalf("unexpected route slot %q", route.Slot)
		}
	}
}

// errorString is a minimal error type for test-only error construction.
type errorString string

func (e errorString) Error() string { return string(e) }
