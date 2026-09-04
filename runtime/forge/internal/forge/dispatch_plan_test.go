package forge

import (
	"encoding/json"
	"os"
	"testing"

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
      "cb-kimi":{"client":"codebuddy","provider":"codebuddy","model":"kimi-k2.6","mode":"native"},
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
		"WRENYARD_GATEWAY_MODELS_JSON":          `[{"id":"hy4-preview-ioa","publicId":"codebuddy/hy4-preview-ioa","provider":"codebuddy","displayName":"HY4 Preview"},{"id":"glm-5.3","publicId":"zhipu-coding/glm-5.3","provider":"zhipu-coding","displayName":"GLM 5.3"}]`,
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
