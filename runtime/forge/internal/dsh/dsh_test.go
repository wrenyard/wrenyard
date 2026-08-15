package dsh

import (
	"reflect"
	"strings"
	"testing"
)

func TestInjectedProviders(t *testing.T) {
	if len(InjectedProviders) != 2 {
		t.Fatalf("expected 2 injected providers, got %d", len(InjectedProviders))
	}
	seen := map[string]bool{}
	for _, p := range InjectedProviders {
		seen[p.ID] = true
		if p.APIType != APITypeOpenAICompletions {
			t.Fatalf("provider %s must use openai-completions, got %q", p.ID, p.APIType)
		}
		if !strings.HasSuffix(p.APIKeyEnv, "API_KEY") && !strings.HasSuffix(p.APIKeyEnv, "SECRET") {
			t.Fatalf("provider %s env %q must end in API_KEY or SECRET", p.ID, p.APIKeyEnv)
		}
	}
	for _, id := range []string{
		"llm-pi-ai.zhipu-coding",
		"llm-pi-ai.kimi-coding",
	} {
		if !seen[id] {
			t.Fatalf("missing provider route %s", id)
		}
	}
}

func TestInjectedProviderCatalogExact(t *testing.T) {
	want := map[string]struct {
		baseURL string
		models  []string
	}{
		"llm-pi-ai.zhipu-coding": {"https://open.bigmodel.cn/api/coding/paas/v4", []string{"glm-5.3"}},
		"llm-pi-ai.kimi-coding":  {"https://api.kimi.com/coding/v1", []string{"k3", "k3[1m]"}},
	}
	for id, w := range want {
		p, ok := ProviderByID(id)
		if !ok {
			t.Fatalf("missing provider %s", id)
		}
		if p.BaseURL != w.baseURL {
			t.Fatalf("provider %s base URL = %q, want %q", id, p.BaseURL, w.baseURL)
		}
		got := p.ModelIDs()
		if !reflect.DeepEqual(got, w.models) {
			t.Fatalf("provider %s models = %v, want %v", id, got, w.models)
		}
	}
}

func TestRenderPatchLoaderOverlay(t *testing.T) {
	patch, err := RenderPatch(PatchInput{})
	if err != nil {
		t.Fatal(err)
	}
	raw := string(patch)
	if !strings.HasPrefix(raw, "# forge dsh patch (generated; secret-free)\n- id: llm-pi-ai\n") {
		t.Fatalf("overlay must be a top-level array led by the llm-pi-ai row:\n%s", raw)
	}
	for _, routeKey := range []string{"zhipu-coding", "kimi-coding"} {
		if !strings.Contains(raw, "      "+routeKey+":") {
			t.Fatalf("providers dict must be keyed by canonical route %q:\n%s", routeKey, raw)
		}
		if strings.Contains(raw, "id: llm-pi-ai."+routeKey) {
			t.Fatalf("route %s must not be re-emitted as a row id", routeKey)
		}
	}
	if strings.Contains(raw, "version:") {
		t.Fatalf("loader overlay must not carry a version key:\n%s", raw)
	}
}

func TestProviderRouteConfigFields(t *testing.T) {
	patch, err := RenderPatch(PatchInput{})
	if err != nil {
		t.Fatal(err)
	}
	raw := string(patch)
	for _, want := range []string{
		"displayName:",
		"api: openai-completions",
		"apiKeyEnv: FORGE_DSH_ZHIPU_CODING_API_KEY",
		"baseURL: " + yamlStr("https://open.bigmodel.cn/api/coding/paas/v4"),
	} {
		if !strings.Contains(raw, want) {
			t.Fatalf("route config missing %q:\n%s", want, raw)
		}
	}
	for _, model := range []string{"glm-5.3", "k3[1m]"} {
		if !strings.Contains(raw, "- id: "+yamlStr(model)) {
			t.Fatalf("route models missing %q:\n%s", model, raw)
		}
	}
	for _, want := range []string{
		"contextWindow: 1048576",
		"maxTokens: 32768",
	} {
		if !strings.Contains(raw, want) {
			t.Fatalf("route model metadata missing %q:\n%s", want, raw)
		}
	}
}

func TestSecretFreeEnvRefs(t *testing.T) {
	patch, err := RenderPatch(PatchInput{})
	if err != nil {
		t.Fatal(err)
	}
	raw := string(patch)
	for _, leak := range []string{"sk-", "key=", "Bearer "} {
		if strings.Contains(raw, leak) {
			t.Fatalf("patch leaks credential-shaped content: %q", leak)
		}
	}
	refs := 0
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "apiKeyEnv: ") {
			continue
		}
		name := strings.TrimPrefix(line, "apiKeyEnv: ")
		if !strings.HasSuffix(name, "API_KEY") && !strings.HasSuffix(name, "SECRET") {
			t.Fatalf("env name %q must end in API_KEY or SECRET", name)
		}
		if strings.Contains(raw, "!!js process.env."+name) {
			refs++
		}
	}
	if refs != 0 {
		t.Fatalf("plain patch without projected headers must not emit Authorization refs")
	}
}

func TestNoNativeDeepSeekInPatch(t *testing.T) {
	patch, err := RenderPatch(PatchInput{})
	if err != nil {
		t.Fatal(err)
	}
	raw := string(patch)
	// The native deepseek-official API dialect must never be re-emitted by
	// the injected llm-pi-ai overlay.
	if strings.Contains(raw, "deepseek-official") {
		t.Fatal("injected patch must not reference native deepseek-official routes")
	}
}

func TestMissingCredentialsKeepRoutesVisible(t *testing.T) {
	if err := ValidateCredentials(nil); err != nil {
		t.Fatalf("nil credentials must be valid: %v", err)
	}
	if err := ValidateCredentials(Credentials{}); err != nil {
		t.Fatalf("empty credentials must be valid: %v", err)
	}
	patch, err := RenderPatch(PatchInput{})
	if err != nil {
		t.Fatal(err)
	}
	raw := string(patch)
	if !strings.Contains(raw, "- id: llm-pi-ai") {
		t.Fatal("llm-pi-ai row must stay visible without credentials")
	}
	for _, routeKey := range []string{"zhipu-coding", "kimi-coding"} {
		if !strings.Contains(raw, "      "+routeKey+":") {
			t.Fatalf("route %s hidden without credentials", routeKey)
		}
	}
}

func TestValidateCredentials(t *testing.T) {
	good := Credentials{"llm-pi-ai.zhipu-coding": {Token: "sk-test-value"}}
	if err := ValidateCredentials(good); err != nil {
		t.Fatalf("valid credentials rejected: %v", err)
	}
	headersOnly := Credentials{"llm-pi-ai.zhipu-coding": {Headers: map[string]string{"X-Domain": "acme"}}}
	if err := ValidateCredentials(headersOnly); err != nil {
		t.Fatalf("header-only credentials rejected: %v", err)
	}
	if err := ValidateCredentials(Credentials{"does-not-exist": {Token: "x"}}); err == nil {
		t.Fatal("unknown provider must fail validation")
	}
	if err := ValidateCredentials(Credentials{"llm-pi-ai.zhipu-coding": {}}); err == nil {
		t.Fatal("credential with neither token nor header must fail validation")
	}
	if err := ValidateCredentials(Credentials{"llm-pi-ai.zhipu-coding": {Headers: map[string]string{"Authorization": "Bearer x"}}}); err == nil {
		t.Fatal("Authorization-only credential must fail validation")
	}
}

func TestLaunchEnvDeterministic(t *testing.T) {
	env := LaunchEnv(Credentials{
		"llm-pi-ai.kimi-coding":  {Token: "v1"},
		"llm-pi-ai.zhipu-coding": {Token: "v2"},
	}, nil)
	if len(env) != 2 {
		t.Fatalf("expected 2 env entries, got %d: %v", len(env), env)
	}
	if env[0] != "FORGE_DSH_KIMI_CODING_API_KEY=v1" {
		t.Fatalf("env must be sorted deterministically, got %v", env)
	}
	env2 := LaunchEnv(Credentials{"llm-pi-ai.kimi-coding": {
		Token:   "v1",
		Headers: map[string]string{"X-Domain": "acme", "Authorization": "Bearer v1"},
	}}, []string{"PATH=/usr/bin"})
	if len(env2) != 3 {
		t.Fatalf("extras must pass through alongside token and header values, got %v", env2)
	}
	got := map[string]string{}
	for _, kv := range env2 {
		k, v, _ := strings.Cut(kv, "=")
		got[k] = v
	}
	if got["PATH"] != "/usr/bin" || got["FORGE_DSH_KIMI_CODING_API_KEY"] != "v1" || got["FORGE_DSH_KIMI_CODING_X_DOMAIN_SECRET"] != "acme" {
		t.Fatalf("child env = %v", got)
	}
	if _, ok := got["FORGE_DSH_KIMI_CODING_AUTHORIZATION_SECRET"]; ok {
		t.Fatal("Authorization must be handled only by apiKeyEnv")
	}
}

func TestProjectProviderChildOnly(t *testing.T) {
	zhipu, _ := ProviderByID("llm-pi-ai.zhipu-coding")
	proj := ProjectProvider(zhipu, TypedCredential{
		Token: "sk-zhipu-token",
		Headers: map[string]string{
			"Authorization": "Bearer sk-zhipu-token",
			"X-Domain":      "acme.example",
			"X-User-Id":     "user-7",
		},
	})
	if proj.Provider.APIKeyEnv != zhipu.APIKeyEnv {
		t.Fatalf("projected provider must keep its api key env, got %q", proj.Provider.APIKeyEnv)
	}
	if proj.Env["FORGE_DSH_ZHIPU_CODING_API_KEY"] != "sk-zhipu-token" {
		t.Fatalf("token must be child-only env value, got %q", proj.Env["FORGE_DSH_ZHIPU_CODING_API_KEY"])
	}
	if proj.Env["FORGE_DSH_ZHIPU_CODING_X_DOMAIN_SECRET"] != "acme.example" {
		t.Fatalf("header value must be child-only, got %q", proj.Env["FORGE_DSH_ZHIPU_CODING_X_DOMAIN_SECRET"])
	}
	if proj.Env["FORGE_DSH_ZHIPU_CODING_X_USER_ID_SECRET"] != "user-7" {
		t.Fatalf("header value must be child-only, got %q", proj.Env["FORGE_DSH_ZHIPU_CODING_X_USER_ID_SECRET"])
	}
	if _, ok := proj.Provider.Headers["Authorization"]; ok {
		t.Fatal("Authorization must be handled only by apiKeyEnv")
	}
	// The projected provider carries only env references, never values.
	for name, envName := range proj.Provider.Headers {
		if strings.Contains(envName, "sk-") || envName == "acme.example" || envName == "user-7" {
			t.Fatalf("provider header %s must reference an env name, got %q", name, envName)
		}
		if !strings.HasSuffix(envName, "SECRET") {
			t.Fatalf("header env %q must end in SECRET", envName)
		}
	}
	// A missing credential keeps the route visible with no env values.
	empty := ProjectProvider(zhipu, TypedCredential{})
	if len(empty.Env) != 0 {
		t.Fatalf("empty credential must project no env values, got %v", empty.Env)
	}
	if empty.Provider.ID != zhipu.ID {
		t.Fatalf("route must stay visible, got %q", empty.Provider.ID)
	}
	if empty.Provider.Headers != nil {
		t.Fatal("empty credential must project no header refs")
	}
}

func TestContextHeaderCoverage(t *testing.T) {
	zhipu, _ := ProviderByID("llm-pi-ai.zhipu-coding")
	proj := ProjectProvider(zhipu, TypedCredential{
		Token: "tok",
		Headers: map[string]string{
			"Authorization":    "Bearer tok",
			"X-Domain":         "d",
			"X-User-Id":        "u",
			"X-Enterprise-Id":  "e",
			"X-Tenant-Id":      "t",
			"X-Product":        "p",
			"X-Requested-With": "r",
		},
	})
	for _, h := range []string{"X-Domain", "X-User-Id", "X-Enterprise-Id", "X-Tenant-Id", "X-Product", "X-Requested-With"} {
		ref, ok := proj.Provider.Headers[h]
		if !ok {
			t.Fatalf("context header %s must be represented", h)
		}
		if ref != headerEnvName(zhipu, h) {
			t.Fatalf("context header %s ref = %q, want %q", h, ref, headerEnvName(zhipu, h))
		}
	}
	patch, err := RenderPatch(PatchInput{Providers: []Provider{proj.Provider}})
	if err != nil {
		t.Fatal(err)
	}
	raw := string(patch)
	for _, h := range []string{"X-Domain", "X-User-Id", "X-Enterprise-Id", "X-Tenant-Id", "X-Product", "X-Requested-With"} {
		if !strings.Contains(raw, h+": "+envRefTag(headerEnvName(zhipu, h))) {
			t.Fatalf("context header %s missing unquoted ref:\n%s", h, raw)
		}
	}
	if strings.Contains(raw, "Authorization:") {
		t.Fatal("Authorization must not be emitted as a header row")
	}
	if strings.Contains(raw, "Bearer ") || strings.Contains(raw, "\"tok\"") {
		t.Fatal("header values must never be serialized")
	}
}

func TestProjectedHeaderRefsUnquoted(t *testing.T) {
	zhipu, _ := ProviderByID("llm-pi-ai.zhipu-coding")
	proj := ProjectProvider(zhipu, TypedCredential{
		Token:   "tok",
		Headers: map[string]string{"X-Domain": "acme"},
	})
	patch, err := RenderPatch(PatchInput{Providers: []Provider{proj.Provider}})
	if err != nil {
		t.Fatal(err)
	}
	raw := string(patch)
	if !strings.Contains(raw, "X-Domain: !!js process.env.FORGE_DSH_ZHIPU_CODING_X_DOMAIN_SECRET") {
		t.Fatalf("header ref must be an unquoted !!js tag:\n%s", raw)
	}
	if strings.Contains(raw, "\"!!js") || strings.Contains(raw, "'!!js") {
		t.Fatal("!!js refs must never be quoted")
	}
}

func TestSelectedDefaultModel(t *testing.T) {
	plain, err := RenderPatch(PatchInput{})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(plain), "agent-default-model") {
		t.Fatal("no selection must not render agent-default-model")
	}
	sel, err := RenderPatch(PatchInput{SelectedModel: "llm-pi-ai.zhipu-coding/glm-5.3"})
	if err != nil {
		t.Fatal(err)
	}
	raw := string(sel)
	if !strings.Contains(raw, "- id: agent-default-model\n  config:\n    provider: llm-pi-ai.zhipu-coding\n    model: glm-5.3") {
		t.Fatalf("explicit selection must render the agent-default-model row:\n%s", raw)
	}
	if _, err := RenderPatch(PatchInput{SelectedModel: "llm-pi-ai.zhipu-coding/does-not-exist"}); err == nil {
		t.Fatal("unknown selected model must fail loudly")
	}
	if _, err := RenderPatch(PatchInput{SelectedModel: "not-a-selection"}); err == nil {
		t.Fatal("malformed selection must fail loudly")
	}
}

func TestSelectedModelEveryProvider(t *testing.T) {
	for _, p := range InjectedProviders {
		if len(p.Models) == 0 {
			t.Fatalf("provider %s must expose at least one model", p.ID)
		}
		for _, m := range p.Models {
			sel := p.ID + "/" + m.ID
			patch, err := RenderPatch(PatchInput{SelectedModel: sel})
			if err != nil {
				t.Fatalf("selected model %s rejected: %v", sel, err)
			}
			if !strings.Contains(string(patch), "- id: agent-default-model") || !strings.Contains(string(patch), "model: "+yamlStr(m.ID)) {
				t.Fatalf("patch must render agent-default-model for %s", sel)
			}
		}
	}
	if _, err := RenderPatch(PatchInput{SelectedModel: "llm-pi-ai.zhipu-coding/glm-5.3"}); err != nil {
		t.Fatalf("zhipu-coding/glm-5.3 must be selectable: %v", err)
	}
	if _, err := RenderPatch(PatchInput{SelectedModel: "llm-pi-ai.kimi-coding/k3[1m]"}); err != nil {
		t.Fatalf("kimi-coding/k3[1m] must be selectable: %v", err)
	}
}

func TestURLNormalization(t *testing.T) {
	for in, want := range map[string]string{
		"https://api.kimi.com/coding/v1":               "https://api.kimi.com/coding/v1",
		"https://api.kimi.com/coding/v1/":              "https://api.kimi.com/coding/v1",
		"https://open.bigmodel.cn/api/coding/paas/v4/": "https://open.bigmodel.cn/api/coding/paas/v4",
	} {
		if got := NormalizeBaseURL(in); got != want {
			t.Fatalf("NormalizeBaseURL(%q) = %q, want %q", in, got, want)
		}
	}
	patch, err := RenderPatch(PatchInput{Providers: []Provider{
		{
			ID:        "llm-pi-ai.kimi-coding",
			APIType:   APITypeOpenAICompletions,
			APIKeyEnv: "FORGE_DSH_KIMI_CODING_API_KEY",
			BaseURL:   "https://api.kimi.com/coding/v1/",
			Models:    []Model{{ID: "k3"}},
		},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(patch), "https://api.kimi.com/coding/v1/") {
		t.Fatal("patch must render normalized base URLs")
	}
	if !strings.Contains(string(patch), "baseURL: "+yamlStr("https://api.kimi.com/coding/v1")) {
		t.Fatal("patch must contain the normalized base URL")
	}
}

func TestMCPRows(t *testing.T) {
	patch, err := RenderPatch(PatchInput{MCPServers: []MCPServer{
		{Name: "filesystem", Transport: MCPTransportStdio, Command: "npx", Args: []string{"-y", "@modelcontextprotocol/server-filesystem", "/workspace"}},
		{Name: "http-gateway", Transport: MCPTransportStreamableHTTP},
	}})
	if err != nil {
		t.Fatal(err)
	}
	raw := string(patch)
	for _, want := range []string{
		"- insert:",
		`id: "@deepseek-ai/dsh-mcp-client"`,
		"serverName: filesystem",
		"transport: stdio",
		"command: npx",
		"serverName: http-gateway",
		"transport: streamable-http",
	} {
		if !strings.Contains(raw, want) {
			t.Fatalf("mcp patch missing %q:\n%s", want, raw)
		}
	}
}

func TestMCPEnvRefsUnquoted(t *testing.T) {
	patch, err := RenderPatch(PatchInput{MCPServers: []MCPServer{
		{Name: "srv", Transport: MCPTransportStdio, Command: "sh", Env: []string{"X=!!js process.env.FORGE_DSH_MCP_SECRET", "Y=literal"}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	raw := string(patch)
	if !strings.Contains(raw, "X: !!js process.env.FORGE_DSH_MCP_SECRET") {
		t.Fatalf("mcp env ref must stay unquoted:\n%s", raw)
	}
	if !strings.Contains(raw, "Y: literal") {
		t.Fatalf("mcp literal env must pass through:\n%s", raw)
	}
}

func TestBridgeInsertRow(t *testing.T) {
	plain, err := RenderPatch(PatchInput{})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(plain), "forge-dsh-bridge") {
		t.Fatal("no bridge row without an explicit plugin path")
	}
	patch, err := RenderPatch(PatchInput{BridgePluginPath: "/abs/forge/bridge.mjs"})
	if err != nil {
		t.Fatal(err)
	}
	raw := string(patch)
	if !strings.Contains(raw, "- insert:\n    id: forge-dsh-bridge\n    name: \"/abs/forge/bridge.mjs\"") {
		t.Fatalf("bridge insert must name the absolute plugin path:\n%s", raw)
	}
}

func TestUnsupportedCapabilities(t *testing.T) {
	if _, err := RenderPatch(PatchInput{Tools: []ToolCapability{ToolBash}}); err == nil {
		t.Fatal("bash capability must be rejected loudly")
	}
	if _, err := RenderPatch(PatchInput{Tools: []ToolCapability{ToolMCP, ToolFS}}); err == nil {
		t.Fatal("non-MCP tool must be rejected loudly")
	}
	if _, err := RenderPatch(PatchInput{MCPServers: []MCPServer{{Name: "x", Transport: "bogus"}}}); err == nil {
		t.Fatal("unknown mcp transport must be rejected loudly")
	}
}

func TestRc6Compatibility(t *testing.T) {
	if ProtocolVersion != "0.1.0-rc.6" {
		t.Fatalf("protocol version drift: %q", ProtocolVersion)
	}
	patch, err := RenderPatch(PatchInput{})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(patch), "- id: llm-pi-ai") {
		t.Fatal("patch must render the rc.6 loader overlay")
	}
}

func TestRenderDeterministic(t *testing.T) {
	zhipu, _ := ProviderByID("llm-pi-ai.zhipu-coding")
	proj := ProjectProvider(zhipu, TypedCredential{Token: "t", Headers: map[string]string{"X-Domain": "d", "X-User-Id": "u"}})
	in := PatchInput{
		Providers:        []Provider{proj.Provider},
		SelectedModel:    "llm-pi-ai.zhipu-coding/glm-5.3",
		MCPServers:       []MCPServer{{Name: "b", Transport: MCPTransportStdio, Command: "node", Args: []string{"b.js"}}, {Name: "a", Transport: MCPTransportStreamableHTTP}},
		BridgePluginPath: "/abs/bridge.mjs",
	}
	one, err := RenderPatch(in)
	if err != nil {
		t.Fatal(err)
	}
	two, err := RenderPatch(in)
	if err != nil {
		t.Fatal(err)
	}
	if string(one) != string(two) {
		t.Fatal("patch render must be deterministic")
	}
	raw := string(one)
	if strings.Index(raw, "serverName: a") > strings.Index(raw, "serverName: b") {
		t.Fatal("mcp rows must be sorted by name")
	}
	xDomain := strings.Index(raw, "X-Domain:")
	xUserID := strings.Index(raw, "X-User-Id:")
	if xDomain < 0 || xUserID < 0 || xDomain > xUserID {
		t.Fatal("headers must be sorted by name")
	}
}

func TestRuntimePatchAssets(t *testing.T) {
	a := DefaultRuntimePatchAssets()
	if a.Version != ProtocolVersion {
		t.Fatalf("assets version drift: %q", a.Version)
	}
	if a.PatchPath == "" {
		t.Fatal("patch path must be set")
	}
	if a.Plugin.Name != PluginName || a.Plugin.Filename == "" || a.Plugin.Source == "" {
		t.Fatal("plugin asset must describe the embedded bridge plugin")
	}
}

func TestBridgeProtocolInvariants(t *testing.T) {
	src := PluginSource
	for _, want := range []string{
		"forge.dsh.stream.v1",
		"session/event",
		"origin === 'subagent'",
		"turn/start",
		"assistant/chunk",
		"assistant/message",
		"tool/call",
		"tool/result",
		"turn/end",
		"fallback",
		"usage",
		"function scrub",
	} {
		if !strings.Contains(src, want) {
			t.Fatalf("bridge source missing invariant %q", want)
		}
	}
	if strings.Contains(src, "FORGE_DSH_") {
		t.Fatal("bridge must never reference forge credential env names")
	}
}
