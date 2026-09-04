package forge

import (
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/dsh"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/execution"
	profilepkg "github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/profile"
)

func TestDirectPlanDirsCreatedBeforeLaterStage(t *testing.T) {
	repo := t.TempDir()
	home := t.TempDir()
	t.Setenv("FORGE_REPO_DIR", repo)
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	setFakeClientsOnPath(t, "claude")
	setTestAuth(t, "kimi-coding", "token-kimi")
	_, err := buildDirectRunPlan(directPlanInput{Profile: "cc-kimi", Prompt: "work", CWD: t.TempDir()})
	if !dirExists(directCCConfigDir()) || !dirExists(directCCJobDir()) {
		t.Fatal("Claude config directories must be created before command/model resolution")
	}
	if err != nil && (strings.Contains(err.Error(), "compatibility") || strings.Contains(err.Error(), "no credential for provider")) {
		t.Fatalf("unexpected pre-routing failure: %v", err)
	}
}

func TestPrepareGatewayDSHRuntimeUsesOnlyLocalToken(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	t.Setenv("WRENYARD_GATEWAY_TOKEN", "local-gateway-token")
	t.Setenv("WRENYARD_GATEWAY_OPENAI_CHAT_URL", "http://127.0.0.1:8787/gateway/openai-chat/v1")

	provider, err := catalog.DefaultRegistry().LookupBinding("zhipu-coding")
	if err != nil {
		t.Fatal(err)
	}
	provider.GatewayRouted = true
	provider.GatewayProtocol = catalog.GatewayProtocolOpenAIChat
	provider.DefaultModel = "glm-5.3"
	prep, err := prepareGatewayClientRuntime(
		execution.ProfileDefinition{Name: "dsh-zhipu", Client: "dsh", Env: map[string]string{catalog.EnvDSHModel: "glm-5.3"}},
		profilepkg.ResolvedProfile{Name: "dsh-zhipu", Provider: provider},
	)
	if err != nil {
		t.Fatal(err)
	}
	if prep.Env[dsh.GatewayAPIKeyEnv] != "local-gateway-token" || len(prep.Env) != 2 {
		t.Fatalf("gateway env = %#v", prep.Env)
	}
	if len(prep.SensitiveEnvKeys) != 1 || prep.SensitiveEnvKeys[0] != dsh.GatewayAPIKeyEnv {
		t.Fatalf("sensitive keys = %v", prep.SensitiveEnvKeys)
	}
	var patch string
	for _, file := range prep.Files {
		if file.RelativePath == "patch.yaml" {
			patch = string(file.Data)
		}
	}
	for _, expected := range []string{"      wrenyard:\n", "apiKeyEnv: WRENYARD_GATEWAY_TOKEN", "provider: llm-pi-ai.wrenyard", "model: zhipu-coding/glm-5.3"} {
		if !strings.Contains(patch, expected) {
			t.Fatalf("patch missing %q:\n%s", expected, patch)
		}
	}
	for _, forbidden := range []string{"local-gateway-token", "open.bigmodel.cn", "FORGE_DSH_ZHIPU"} {
		if strings.Contains(patch, forbidden) {
			t.Fatalf("patch contains forbidden value %q", forbidden)
		}
	}
}

func TestParseAgentPermissionModeAliasNormalization(t *testing.T) {
	tests := []struct {
		raw       string
		want      catalog.PermissionMode
		wantError bool
	}{
		{"full", catalog.PermissionYolo, false},
		{"standard", catalog.PermissionYolo, false},
		{"exec", catalog.PermissionYolo, false},
		{"edit", catalog.PermissionEdit, false},
		{"readonly", catalog.PermissionReadonly, false},
		{"yolo", catalog.PermissionYolo, false},
		{"", catalog.PermissionEdit, false},
		{"invalid", catalog.PermissionEdit, true},
	}
	for _, tt := range tests {
		t.Run("parseAgentPerm_"+tt.raw, func(t *testing.T) {
			got, err := parseDirectPermissionMode(tt.raw)
			if got != tt.want || (err != nil) != tt.wantError {
				t.Fatalf("parseDirectPermissionMode(%q) = (%q, %v)", tt.raw, got, err)
			}
		})
	}
}
