package forge

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/driver"
	profilepkg "github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/profile"
)

func TestMain(m *testing.M) {
	if os.Getenv("WRENYARD_DISPATCH_PLANS_JSON") == "" {
		_ = os.Setenv("WRENYARD_DISPATCH_PLANS_JSON", `{
      "codex-sol":{"client":"codex","provider":"codex","model":"gpt-5.6-sol","mode":"native"},
      "codex-terra":{"client":"codex","provider":"codex","model":"gpt-5.6-terra","mode":"native"},
      "codex-luna":{"client":"codex","provider":"codex","model":"gpt-5.6-luna","mode":"native"},
      "codex-spark":{"client":"codex","provider":"codex-spark","model":"gpt-5.3-codex-spark","mode":"native"},
      "cb-hy":{"client":"codebuddy","provider":"codebuddy","model":"hy4-preview","mode":"native"},
      "cb-ds":{"client":"codebuddy","provider":"codebuddy","model":"deepseek-v4.1-flash","mode":"native"},
      "cb-dsf":{"client":"codebuddy","provider":"codebuddy","model":"deepseek-v4.1-flash","mode":"native"},
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

// --- CodeBuddy native-plan admission fixtures ---

// codeBuddyAuthFixturePath mirrors the native CodeBuddy auth file location the
// auth resolver reads for the current platform.
func codeBuddyAuthFixturePath(home string) string {
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth", "Tencent-Cloud.coding-copilot.info")
	case "windows":
		localAppData := os.Getenv("LOCALAPPDATA")
		if localAppData == "" {
			localAppData = filepath.Join(home, "AppData", "Local")
		}
		return filepath.Join(localAppData, "CodeBuddyExtension", "Data", "Public", "auth", "Tencent-Cloud.coding-copilot.info")
	default:
		return filepath.Join(home, ".local", "share", "CodeBuddyExtension", "Data", "Public", "auth", "Tencent-Cloud.coding-copilot.info")
	}
}

// codeBuddyAuthFileJSON renders a synthetic native CodeBuddy auth file body.
// An empty uid omits the stable account identity so the active scope fails
// closed.
func codeBuddyAuthFileJSON(domain, uid, accessToken string) []byte {
	auth := map[string]interface{}{
		"accessToken": accessToken,
		"domain":      domain,
	}
	payload := map[string]interface{}{"auth": auth}
	if uid != "" {
		payload["account"] = map[string]interface{}{"uid": uid}
	}
	raw, _ := json.Marshal(payload)
	return raw
}

// writeCodeBuddyAuthFile overwrites a synthetic native CodeBuddy auth file.
func writeCodeBuddyAuthFile(t *testing.T, authPath, domain, uid, accessToken string) {
	t.Helper()
	if err := os.WriteFile(authPath, codeBuddyAuthFileJSON(domain, uid, accessToken), 0o600); err != nil {
		t.Fatal(err)
	}
}

// writeCodeBuddyAuthFixture plants a synthetic native CodeBuddy auth file and
// a product.json classifying the four environments, then points the process
// at them via HOME/USERPROFILE/LOCALAPPDATA and ACC_PRODUCT_CONFIG_PATH. It
// returns the auth file path so tests can simulate an account switch or token
// refresh between dispatch calls.
func writeCodeBuddyAuthFixture(t *testing.T, domain, uid, accessToken string) string {
	t.Helper()
	home := t.TempDir()
	authPath := codeBuddyAuthFixturePath(home)
	if err := os.MkdirAll(filepath.Dir(authPath), 0o700); err != nil {
		t.Fatal(err)
	}
	writeCodeBuddyAuthFile(t, authPath, domain, uid, accessToken)

	product := map[string]interface{}{
		"authentication": map[string]interface{}{
			"attributes": map[string]interface{}{
				"internalDomain":    "internal.example.com",
				"iOADomain":         "ioa.example.com",
				"cloudHostedDomain": "cloud.example.com",
				"externalDomain":    "external.example.com",
			},
		},
	}
	productRaw, err := json.Marshal(product)
	if err != nil {
		t.Fatal(err)
	}
	productPath := filepath.Join(t.TempDir(), "product.json")
	if err := os.WriteFile(productPath, productRaw, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("LOCALAPPDATA", filepath.Join(home, "AppData", "Local"))
	t.Setenv("ACC_PRODUCT_CONFIG_PATH", productPath)
	return authPath
}

// seedCodeBuddyNativePlan seeds a native codebuddy dispatch plan for a profile
// id with a canonical model.
func seedCodeBuddyNativePlan(t *testing.T, profileID, model string) {
	t.Helper()
	setTestDispatchPlan(t, profileID, profilepkg.DispatchPlan{
		Client: "codebuddy", Provider: "codebuddy", Model: model, Mode: "native",
	})
}

// setCodeBuddyExpectedTuple binds the private expected CodeBuddy admission
// tuple through the driver env names.
func setCodeBuddyExpectedTuple(t *testing.T, scope, environment, wireModel string) {
	t.Helper()
	t.Setenv(driver.CodeBuddyExpectedScopeEnv, scope)
	t.Setenv(driver.CodeBuddyExpectedEnvironmentEnv, environment)
	t.Setenv(driver.CodeBuddyExpectedWireModelEnv, wireModel)
}

// clearCodeBuddyExpectedTuple empties the private expected CodeBuddy admission
// tuple so missing-context tests are hermetic.
func clearCodeBuddyExpectedTuple(t *testing.T) {
	t.Helper()
	t.Setenv(driver.CodeBuddyExpectedScopeEnv, "")
	t.Setenv(driver.CodeBuddyExpectedEnvironmentEnv, "")
	t.Setenv(driver.CodeBuddyExpectedWireModelEnv, "")
}

func TestDispatchPlanCodeBuddyIOAAdmissionMaterializesWireModels(t *testing.T) {
	writeCodeBuddyAuthFixture(t, "ioa.example.com", "uid-1", "tok-a")
	active := authStatusResolver().CodeBuddyActiveScope()
	if !active.OK || active.Environment != "ioa" || active.Scope == "" {
		t.Fatalf("synthetic ioa fixture must resolve an active ioa scope, got %+v", active)
	}

	assertAdmitted := func(label, model, wantWire string) {
		t.Helper()
		profileID := "cb-bind-ioa-" + label
		seedCodeBuddyNativePlan(t, profileID, model)
		setCodeBuddyExpectedTuple(t, active.Scope, active.Environment, wantWire)
		plan, err := dispatchPlanForProfile(profileID)
		if err != nil {
			t.Fatalf("%s: canonical model %s must be admitted in the ioa environment: %v", label, model, err)
		}
		if plan.Model != wantWire {
			t.Fatalf("%s: plan model = %q, want exact wire id %q", label, plan.Model, wantWire)
		}
	}

	cases := []struct{ label, canonical, wire string }{
		{"deepseek-v4.1-flash", "deepseek-v4.1-flash", "deepseek-v4.1-flash-ioa"},
		{"hy4-preview", "hy4-preview", "hy4-preview-ioa"},
		{"hy3", "hy3", "hy3-ioa"},
		{"minimax-m3", "minimax-m3", "minimax-m3-ioa"},
	}
	for _, tc := range cases {
		assertAdmitted(tc.label, tc.canonical, tc.wire)
	}

	// Already-wire models remain unchanged under ioa.
	assertAdmitted("already-wire", "hy4-preview-ioa", "hy4-preview-ioa")

	// Non-iOA models stay canonical under ioa.
	assertAdmitted("kimi-k3", "kimi-k3", "kimi-k3")
}

func TestDispatchPlanCodeBuddyExternalAdmissionKeepsCanonicalModel(t *testing.T) {
	writeCodeBuddyAuthFixture(t, "external.example.com", "uid-ext", "tok-ext")
	active := authStatusResolver().CodeBuddyActiveScope()
	if !active.OK || active.Environment != "external" || active.Scope == "" {
		t.Fatalf("synthetic external fixture must resolve an active external scope, got %+v", active)
	}
	profileID := "cb-bind-external-hy4-preview"
	seedCodeBuddyNativePlan(t, profileID, "hy4-preview")
	// External/non-iOA leaves the model canonical, so the expected wire equals
	// the canonical model.
	setCodeBuddyExpectedTuple(t, active.Scope, active.Environment, "hy4-preview")
	plan, err := dispatchPlanForProfile(profileID)
	if err != nil {
		t.Fatalf("canonical model in an external environment must be admitted: %v", err)
	}
	if plan.Model != "hy4-preview" {
		t.Fatalf("external plan model = %q, want unchanged canonical hy4-preview", plan.Model)
	}
}

func TestDispatchPlanCodeBuddyTokenRefreshKeepsStableIdentityAdmitted(t *testing.T) {
	authPath := writeCodeBuddyAuthFixture(t, "ioa.example.com", "uid-refresh", "tok-1")
	active := authStatusResolver().CodeBuddyActiveScope()
	if !active.OK {
		t.Fatalf("synthetic fixture must resolve an active scope, got %+v", active)
	}
	profileID := "cb-bind-refresh"
	seedCodeBuddyNativePlan(t, profileID, "hy4-preview")
	setCodeBuddyExpectedTuple(t, active.Scope, active.Environment, "hy4-preview-ioa")
	plan, err := dispatchPlanForProfile(profileID)
	if err != nil {
		t.Fatalf("first admission must succeed: %v", err)
	}
	if plan.Model != "hy4-preview-ioa" {
		t.Fatalf("plan model = %q, want hy4-preview-ioa", plan.Model)
	}

	// Refresh the access token: same stable identity, domain, and environment,
	// so the scope is unchanged and the plan stays admitted.
	writeCodeBuddyAuthFile(t, authPath, "ioa.example.com", "uid-refresh", "tok-2")
	plan, err = dispatchPlanForProfile(profileID)
	if err != nil {
		t.Fatalf("token refresh with a stable identity must remain admitted: %v", err)
	}
	if plan.Model != "hy4-preview-ioa" {
		t.Fatalf("post-refresh plan model = %q, want hy4-preview-ioa", plan.Model)
	}
}

func TestDispatchPlanCodeBuddyAccountSwitchFailsClosed(t *testing.T) {
	authPath := writeCodeBuddyAuthFixture(t, "ioa.example.com", "uid-a", "tok-a")
	active := authStatusResolver().CodeBuddyActiveScope()
	if !active.OK {
		t.Fatalf("synthetic fixture must resolve an active scope, got %+v", active)
	}
	profileID := "cb-bind-account-switch"
	seedCodeBuddyNativePlan(t, profileID, "hy4-preview")
	setCodeBuddyExpectedTuple(t, active.Scope, active.Environment, "hy4-preview-ioa")
	if _, err := dispatchPlanForProfile(profileID); err != nil {
		t.Fatalf("first admission must succeed: %v", err)
	}

	// Switch account: a different stable identity on the same domain changes
	// the opaque scope, so the next admission must fail closed.
	writeCodeBuddyAuthFile(t, authPath, "ioa.example.com", "uid-b", "tok-b")
	if _, err := dispatchPlanForProfile(profileID); err == nil {
		t.Fatal("account/scope switch must fail closed before materialization")
	}
}

func TestDispatchPlanCodeBuddyEnvironmentSwitchFailsClosed(t *testing.T) {
	authPath := writeCodeBuddyAuthFixture(t, "ioa.example.com", "uid-env", "tok-env")
	active := authStatusResolver().CodeBuddyActiveScope()
	if !active.OK || active.Environment != "ioa" {
		t.Fatalf("synthetic ioa fixture must resolve ioa, got %+v", active)
	}
	profileID := "cb-bind-env-switch"
	seedCodeBuddyNativePlan(t, profileID, "hy4-preview")
	setCodeBuddyExpectedTuple(t, active.Scope, active.Environment, "hy4-preview-ioa")
	if _, err := dispatchPlanForProfile(profileID); err != nil {
		t.Fatalf("initial ioa admission must succeed: %v", err)
	}

	// Switch the active login to an external domain while keeping the stable
	// account id. The expected tuple remains bound to the prior ioa snapshot,
	// so the next admission must fail before plan materialization.
	writeCodeBuddyAuthFile(t, authPath, "external.example.com", "uid-env", "tok-external")
	if _, err := dispatchPlanForProfile(profileID); err == nil {
		t.Fatal("active-login environment switch must fail closed before materialization")
	}
}

func TestDispatchPlanCodeBuddyExpectedWireMismatchFailsClosed(t *testing.T) {
	writeCodeBuddyAuthFixture(t, "ioa.example.com", "uid-wire", "tok-wire")
	active := authStatusResolver().CodeBuddyActiveScope()
	if !active.OK {
		t.Fatalf("synthetic fixture must resolve an active scope, got %+v", active)
	}
	profileID := "cb-bind-wire-mismatch"
	seedCodeBuddyNativePlan(t, profileID, "hy4-preview")
	// Scope and environment match, but the expected wire model is for a
	// different canonical plan.
	setCodeBuddyExpectedTuple(t, active.Scope, active.Environment, "deepseek-v4.1-flash-ioa")
	if _, err := dispatchPlanForProfile(profileID); err == nil {
		t.Fatal("expected-wire mismatch must fail closed before materialization")
	}
}

func TestDispatchPlanCodeBuddyMissingContextFailsClosed(t *testing.T) {
	writeCodeBuddyAuthFixture(t, "ioa.example.com", "uid-missing", "tok-missing")
	profileID := "cb-bind-missing-context"
	seedCodeBuddyNativePlan(t, profileID, "hy4-preview")

	// Complete tuple absent.
	clearCodeBuddyExpectedTuple(t)
	if _, err := dispatchPlanForProfile(profileID); err == nil {
		t.Fatal("missing private expected tuple must fail closed")
	}

	// Partial tuple: only the environment is bound.
	active := authStatusResolver().CodeBuddyActiveScope()
	if !active.OK {
		t.Fatalf("synthetic fixture must resolve an active scope, got %+v", active)
	}
	clearCodeBuddyExpectedTuple(t)
	t.Setenv(driver.CodeBuddyExpectedEnvironmentEnv, active.Environment)
	if _, err := dispatchPlanForProfile(profileID); err == nil {
		t.Fatal("a partial private expected tuple must fail closed")
	}
}

func TestDispatchPlanCodeBuddyMissingStableIdentityFailsClosed(t *testing.T) {
	writeCodeBuddyAuthFixture(t, "ioa.example.com", "", "tok-no-id")
	active := authStatusResolver().CodeBuddyActiveScope()
	if active.OK {
		t.Fatalf("fixture without a stable account identity must resolve nothing, got %+v", active)
	}
	profileID := "cb-bind-no-stable-id"
	seedCodeBuddyNativePlan(t, profileID, "hy4-preview")
	setCodeBuddyExpectedTuple(t, "cbv1:anything", "ioa", "hy4-preview-ioa")
	if _, err := dispatchPlanForProfile(profileID); err == nil {
		t.Fatal("missing stable identity must fail closed before materialization")
	}
}

func TestDispatchPlanCodeBuddyUnclassifiedEnvironmentFailsClosed(t *testing.T) {
	writeCodeBuddyAuthFixture(t, "nomatch.example.com", "uid-unclassified", "tok")
	active := authStatusResolver().CodeBuddyActiveScope()
	if active.OK {
		t.Fatalf("unclassified environment must resolve nothing, got %+v", active)
	}
	profileID := "cb-bind-unclassified"
	seedCodeBuddyNativePlan(t, profileID, "hy4-preview")
	setCodeBuddyExpectedTuple(t, "cbv1:anything", "ioa", "hy4-preview-ioa")
	if _, err := dispatchPlanForProfile(profileID); err == nil {
		t.Fatal("an unclassified environment must fail closed before materialization")
	}
}

func TestDispatchPlanCodeBuddyErrorsHidePrivateValues(t *testing.T) {
	authPath := writeCodeBuddyAuthFixture(t, "ioa.example.com", "uid-priv", "tok-priv")
	active := authStatusResolver().CodeBuddyActiveScope()
	if !active.OK {
		t.Fatalf("synthetic fixture must resolve an active scope, got %+v", active)
	}
	profileID := "cb-bind-privacy"
	seedCodeBuddyNativePlan(t, profileID, "hy4-preview")
	setCodeBuddyExpectedTuple(t, active.Scope, active.Environment, "hy4-preview-ioa")
	if _, err := dispatchPlanForProfile(profileID); err != nil {
		t.Fatalf("first admission must succeed: %v", err)
	}

	// Force an account-switch failure, then assert the error exposes none of
	// the private values.
	writeCodeBuddyAuthFile(t, authPath, "ioa.example.com", "uid-priv-2", "tok-priv-2")
	_, err := dispatchPlanForProfile(profileID)
	if err == nil {
		t.Fatal("account switch must fail closed")
	}
	for _, private := range []string{
		active.Scope, "ioa", "ioa.example.com", "uid-priv", "uid-priv-2",
		"hy4-preview-ioa", "hy4-preview", "WRENYARD_CODEBUDDY_EXPECTED_SCOPE",
		"WRENYARD_CODEBUDDY_EXPECTED_ENVIRONMENT", "WRENYARD_CODEBUDDY_EXPECTED_WIRE_MODEL",
	} {
		if strings.Contains(err.Error(), private) {
			t.Fatalf("admission error leaked private value %q: %v", private, err)
		}
	}
}

func TestDispatchPlanNonCodeBuddyPlansUnaffectedByMissingContext(t *testing.T) {
	clearCodeBuddyExpectedTuple(t)
	t.Setenv("HOME", t.TempDir())
	t.Setenv("USERPROFILE", t.TempDir())

	profileID := "cb-unaffected-codex"
	setTestDispatchPlan(t, profileID, profilepkg.DispatchPlan{
		Client: "codex", Provider: "codex", Model: "gpt-5.6-terra", Mode: "native",
	})
	plan, err := dispatchPlanForProfile(profileID)
	if err != nil {
		t.Fatalf("non-CodeBuddy native plan must stay available without admission context: %v", err)
	}
	if plan.Model != "gpt-5.6-terra" {
		t.Fatalf("non-CodeBuddy plan model = %q, want unchanged gpt-5.6-terra", plan.Model)
	}

	// A gateway plan also stays byte-for-byte unchanged.
	gateway, err := dispatchPlanForProfile("cc-kimi")
	if err != nil {
		t.Fatalf("gateway plan must stay available without admission context: %v", err)
	}
	if gateway.Client != "claude" || gateway.Provider != "kimi-coding" || gateway.Model != "k3" {
		t.Fatalf("gateway plan mutated without admission context: %#v", gateway)
	}
}
