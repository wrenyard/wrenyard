package forge

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
	profilepkg "github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/profile"
)

func TestMain(m *testing.M) {
	if os.Getenv("WRENYARD_DISPATCH_PLANS_JSON") == "" {
		_ = os.Setenv("WRENYARD_DISPATCH_PLANS_JSON", `{
      "codex-sol":{"client":"codex","provider":"codex","model":"gpt-5.6-sol","mode":"native"},
      "codex-terra":{"client":"codex","provider":"codex","model":"gpt-5.6-terra","mode":"native"},
      "codex-luna":{"client":"codex","provider":"codex","model":"gpt-5.6-luna","mode":"native"},
      "codex-spark":{"client":"codex","provider":"codex-spark","model":"gpt-5.3-codex-spark","mode":"native"},
      "cb-hy":{"client":"codebuddy","provider":"codebuddy","model":"hy4-preview-ioa","mode":"native"},
      "cb-ds":{"client":"codebuddy","provider":"codebuddy","model":"deepseek-v4-pro","mode":"native"},
      "cb-dsf":{"client":"codebuddy","provider":"codebuddy","model":"deepseek-v4-flash","mode":"native"},
      "cb-minimax":{"client":"codebuddy","provider":"codebuddy","model":"minimax-m3","mode":"native"},
      "cb-kimi":{"client":"codebuddy","provider":"codebuddy","model":"kimi-k3","mode":"native"},
      "cb-glm":{"client":"codebuddy","provider":"codebuddy","model":"glm-5.3","mode":"native"},
      "cb-glmf":{"client":"codebuddy","provider":"codebuddy","model":"glm-5.3-flash","mode":"native"},
      "cc-kimi":{"client":"claude","provider":"kimi-coding","model":"k3","mode":"gateway","protocol":"anthropic_messages"},
      "cc-glm":{"client":"claude","provider":"zhipu-coding","model":"glm-5.3","mode":"gateway","protocol":"anthropic_messages"},
      "cc-glmf":{"client":"claude","provider":"zhipu-coding","model":"glm-5.3-flash","mode":"gateway","protocol":"anthropic_messages"},
      "gk-glm":{"client":"grok","provider":"zhipu-coding","model":"glm-5.3","mode":"gateway","protocol":"openai_chat"},
      "gk-glmf":{"client":"grok","provider":"zhipu-coding","model":"glm-5.3-flash","mode":"gateway","protocol":"openai_chat"},
      "gk-kimi":{"client":"grok","provider":"kimi-coding","model":"k3","mode":"gateway","protocol":"openai_chat"},
      "gk-grok":{"client":"grok","provider":"spacex-ai","model":"grok-4.5","mode":"native"},
      "cur-composer":{"client":"cursor","provider":"cursor","model":"composer-2.5","mode":"native"},
      "cur-grok":{"client":"cursor","provider":"cursor","model":"cursor-grok-4.6-high","mode":"native"},
      "cur-kimi":{"client":"cursor","provider":"cursor","model":"kimi-k3","mode":"native"},
      "cur-opus":{"client":"cursor","provider":"cursor","model":"claude-opus-5","mode":"native"}
    }`)
	}
	for key, value := range map[string]string{
		"WRENYARD_GATEWAY_TOKEN":                "test-gateway-token",
		"WRENYARD_GATEWAY_OPENAI_CHAT_URL":      "http://127.0.0.1:4312/gateway/openai-chat/v1",
		"WRENYARD_GATEWAY_OPENAI_RESPONSES_URL": "http://127.0.0.1:4312/gateway/openai-responses/v1",
		"WRENYARD_GATEWAY_ANTHROPIC_URL":        "http://127.0.0.1:4312/gateway/anthropic/v1",
		"WRENYARD_GATEWAY_MODELS_JSON":          `[{"id":"hy4-preview","publicId":"codebuddy/hy4-preview","provider":"codebuddy","displayName":"HY4 Preview"},{"id":"glm-5.3","publicId":"zhipu-coding/glm-5.3","provider":"zhipu-coding","displayName":"GLM 5.3"}]`,
	} {
		if os.Getenv(key) == "" {
			_ = os.Setenv(key, value)
		}
	}
	os.Exit(m.Run())
}

func setTestDispatchPlan(t *testing.T, profileID string, plan profilepkg.DispatchPlan) {
	t.Helper()
	plans := map[string]profilepkg.DispatchPlan{}
	if err := json.Unmarshal([]byte(os.Getenv("WRENYARD_DISPATCH_PLANS_JSON")), &plans); err != nil {
		t.Fatal(err)
	}
	plans[profileID] = plan
	raw, err := json.Marshal(plans)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("WRENYARD_DISPATCH_PLANS_JSON", string(raw))
}

// TestLoadProfileAcceptsDaemonPlanForCanonicalTargetWithoutRecipe covers the
// Go execution bridge when the legacy source manifest is empty: a requested
// runtime key resolves strictly from its daemon dispatch plan and materializes
// through ResolveProfile. It requires no Go alias registry, run-syntax parser,
// or profile recipe.
func TestLoadProfileAcceptsDaemonPlanForCanonicalTargetWithoutRecipe(t *testing.T) {
	// A canonical provider/model:client target key loads and resolves with no
	// manifest profile behind it.
	canonical := "kimi-coding/k3:cc"
	setTestDispatchPlan(t, canonical, profilepkg.DispatchPlan{
		Client: "claude", Provider: "kimi-coding", Model: "k3", Mode: "gateway",
		Protocol: catalog.GatewayProtocolAnthropic,
	})
	def, ok, err := executionDependencies().LoadProfile(canonical)
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatalf("LoadProfile(%q) = not found, want a plan-backed definition", canonical)
	}
	if def.Client != "claude" || def.Provider != "kimi-coding" {
		t.Fatalf("plan-backed definition = client %q provider %q, want claude/kimi-coding", def.Client, def.Provider)
	}
	resolved, err := executionDependencies().ResolveProfile(def)
	if err != nil {
		t.Fatalf("ResolveProfile(%q): %v", canonical, err)
	}
	if got := resolved.Env["ANTHROPIC_MODEL"]; got != "k3[1m]" {
		t.Fatalf("ANTHROPIC_MODEL = %q, want k3[1m] from plan materialization", got)
	}

	// A legacy-style managed name that used to live only in the source
	// manifest (cc-kimi) also loads strictly from its plan fixture and still
	// proves cc+kimi k3[1m] materialization.
	legacyName := "cc-kimi"
	def, ok, err = executionDependencies().LoadProfile(legacyName)
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatalf("LoadProfile(%q) = not found, want a plan-backed definition", legacyName)
	}
	if def.Client != "claude" || def.Provider != "kimi-coding" {
		t.Fatalf("plan-backed definition = client %q provider %q, want claude/kimi-coding", def.Client, def.Provider)
	}
	resolved, err = executionDependencies().ResolveProfile(def)
	if err != nil {
		t.Fatalf("ResolveProfile(%q): %v", legacyName, err)
	}
	if got := resolved.Env["ANTHROPIC_MODEL"]; got != "k3[1m]" {
		t.Fatalf("cc-kimi ANTHROPIC_MODEL = %q, want k3[1m] from plan materialization", got)
	}
}

func TestLoadProfileFailsClosedWhenCanonicalTargetHasNoPlan(t *testing.T) {
	canonical := "codex/no-such-model:codex"
	def, ok, err := executionDependencies().LoadProfile(canonical)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatalf("LoadProfile(%q) = found (client %q), want not found without a dispatch plan", canonical, def.Client)
	}
}

func TestLoadProfileFailsClosedWhenCanonicalPlanHasUnknownClientOrProvider(t *testing.T) {
	t.Run("unknown client adapter", func(t *testing.T) {
		key := "ghost-client/gpt-6-astra:codex"
		setTestDispatchPlan(t, key, profilepkg.DispatchPlan{
			Client: "ghost-client", Provider: "codex", Model: "gpt-6-astra", Mode: "native",
		})
		_, ok, err := executionDependencies().LoadProfile(key)
		if err != nil {
			t.Fatal(err)
		}
		if ok {
			t.Fatalf("LoadProfile(%q) = found, want unavailable for an unknown client adapter", key)
		}
	})
	t.Run("unknown provider adapter", func(t *testing.T) {
		key := "codex/ghost-provider:codex"
		setTestDispatchPlan(t, key, profilepkg.DispatchPlan{
			Client: "codex", Provider: "ghost-provider", Model: "gpt-6-astra", Mode: "native",
		})
		_, ok, err := executionDependencies().LoadProfile(key)
		if err != nil {
			t.Fatal(err)
		}
		if ok {
			t.Fatalf("LoadProfile(%q) = found, want unavailable for an unknown provider adapter", key)
		}
	})
}

// TestLoadProfileGLMSplitRouteCanonicalPlanOnly reproduces the GLM split-route
// regression: a stale legacy-style direct BigModel definition (claude client +
// zhipu-coding provider) must not survive into a canonical run. The canonical
// exact key zhipu-coding/glm-5.3-flash:cc is seeded with an anthropic-messages
// gateway plan, and LoadProfile/ResolveProfile/PrepareRuntime must consume only
// that selected dispatch plan: the resolved provider is gateway-routed, the
// active model is the plan model, and the runtime preparation is built strictly
// from WRENYARD_GATEWAY_TOKEN + WRENYARD_GATEWAY_ANTHROPIC_URL. Claude Code
// stays the explicit client; no model id changes, no alias is added, and no
// provider is probed.
func TestLoadProfileGLMSplitRouteCanonicalPlanOnly(t *testing.T) {
	canonical := "zhipu-coding/glm-5.3-flash:cc"
	legacyDirectEndpoint := "https://open.bigmodel.cn/api/anthropic"
	legacyDirectToken := "legacy-direct-bigmodel-token"

	t.Run("canonical plan present materializes the gateway runtime from the plan only", func(t *testing.T) {
		setTestDispatchPlan(t, canonical, profilepkg.DispatchPlan{
			Client:   "claude",
			Provider: "zhipu-coding",
			Model:    "glm-5.3-flash",
			Mode:     "gateway",
			Protocol: catalog.GatewayProtocolAnthropic,
		})
		def, ok, err := executionDependencies().LoadProfile(canonical)
		if err != nil {
			t.Fatal(err)
		}
		if !ok {
			t.Fatalf("LoadProfile(%q) = not found, want a plan-backed definition", canonical)
		}
		if def.Client != "claude" || def.Provider != "zhipu-coding" {
			t.Fatalf("plan-backed definition = client %q provider %q, want claude/zhipu-coding", def.Client, def.Provider)
		}

		// Stale legacy-style direct-profile fields ride on the input
		// ProfileDefinition (the pre-gateway bridge pointed at the direct
		// BigModel endpoint with its own model/secret): none of them may
		// resurface in the resolved route, active model, credential, or the
		// runtime preparation.
		def.Env = map[string]string{
			"ANTHROPIC_BASE_URL":   legacyDirectEndpoint,
			"ANTHROPIC_MODEL":      "glm-5.3",
			"ANTHROPIC_AUTH_TOKEN": legacyDirectToken,
		}

		resolved, err := executionDependencies().ResolveProfile(def)
		if err != nil {
			t.Fatalf("ResolveProfile(%q): %v", canonical, err)
		}
		if !resolved.Provider.GatewayRouted {
			t.Fatalf("provider for %q = gateway-routed %v, want true from the selected gateway plan", canonical, resolved.Provider.GatewayRouted)
		}
		if resolved.Provider.GatewayProtocol != catalog.GatewayProtocolAnthropic {
			t.Fatalf("provider for %q = gateway protocol %q, want %q", canonical, resolved.Provider.GatewayProtocol, catalog.GatewayProtocolAnthropic)
		}
		if resolved.Provider.Name != "zhipu-coding" || resolved.Provider.DefaultModel != "glm-5.3-flash" {
			t.Fatalf("provider for %q = %q/%q, want zhipu-coding/glm-5.3-flash from the plan", canonical, resolved.Provider.Name, resolved.Provider.DefaultModel)
		}
		if public := resolved.Provider.Name + "/" + resolved.Provider.DefaultModel; public != "zhipu-coding/glm-5.3-flash" {
			t.Fatalf("public model = %q, want zhipu-coding/glm-5.3-flash", public)
		}
		// The stale legacy model override on the definition is overwritten by
		// the selected plan's model for the claude client.
		if got := resolved.Env["ANTHROPIC_MODEL"]; got != "glm-5.3-flash" {
			t.Fatalf("resolved ANTHROPIC_MODEL = %q, want glm-5.3-flash; legacy model override must not survive", got)
		}
		// Gateway credential provenance: no direct BigModel secret resolves.
		if resolved.Credential.Source != "gateway" || resolved.Credential.Value != "" {
			t.Fatalf("resolved credential = source %q value %q, want gateway provenance with no direct secret", resolved.Credential.Source, resolved.Credential.Value)
		}

		prep, err := executionDependencies().PrepareRuntime(def, resolved)
		if err != nil {
			t.Fatalf("PrepareRuntime(%q): %v", canonical, err)
		}
		gatewayURL := os.Getenv("WRENYARD_GATEWAY_ANTHROPIC_URL")
		gatewayToken := os.Getenv("WRENYARD_GATEWAY_TOKEN")
		if prep.Env["WRENYARD_GATEWAY_ANTHROPIC_URL"] != gatewayURL {
			t.Fatalf("preparation base URL = %q, want %q (WRENYARD_GATEWAY_ANTHROPIC_URL)", prep.Env["WRENYARD_GATEWAY_ANTHROPIC_URL"], gatewayURL)
		}
		if prep.Env["WRENYARD_GATEWAY_TOKEN"] != gatewayToken {
			t.Fatalf("preparation token = %q, want %q (WRENYARD_GATEWAY_TOKEN)", prep.Env["WRENYARD_GATEWAY_TOKEN"], gatewayToken)
		}
		for k, v := range prep.Env {
			if strings.Contains(k, "open.bigmodel.cn") || strings.Contains(v, "open.bigmodel.cn") || strings.Contains(v, legacyDirectToken) {
				t.Fatalf("preparation leaked a legacy direct-BigModel value: %s=%s", k, v)
			}
		}
		if _, ok := prep.Env["ANTHROPIC_BASE_URL"]; ok {
			t.Fatalf("preparation must not carry ANTHROPIC_BASE_URL; the claude gateway route derives it from WRENYARD_GATEWAY_ANTHROPIC_URL")
		}
		sensitive := false
		for _, key := range prep.SensitiveEnvKeys {
			if key == "WRENYARD_GATEWAY_TOKEN" {
				sensitive = true
			}
		}
		if !sensitive {
			t.Fatalf("preparation must mark WRENYARD_GATEWAY_TOKEN as a sensitive env key")
		}
	})

	t.Run("canonical plan absent fails closed before any runtime preparation", func(t *testing.T) {
		// The ambient dispatch plans keep only the legacy cc-glmf alias
		// (claude/zhipu-coding/glm-5.3-flash); the canonical exact key is
		// absent, so LoadProfile must report unavailable before the
		// ResolveProfile/PrepareRuntime seams and must not fall back to the
		// cc-glmf alias plan or to a source profile.
		def, ok, err := executionDependencies().LoadProfile(canonical)
		if err != nil {
			t.Fatal(err)
		}
		if ok {
			t.Fatalf("LoadProfile(%q) = found (client %q provider %q), want unavailable: the canonical plan is absent and cc-glmf must not be used as a fallback", canonical, def.Client, def.Provider)
		}
	})
}
