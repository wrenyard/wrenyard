package dsh

import (
	"reflect"
	"strings"
	"testing"
)

func testGatewayProvider() Provider {
	return GatewayProvider("http://127.0.0.1:9000/gateway/openai-chat/v1/", []Model{
		{ID: "zhipu-coding/glm-5.3", Label: "GLM 5.3", ContextWindow: 1048576, MaxTokens: 32768},
		{ID: "codebuddy/hy4-preview-ioa", Label: "HY4 Preview"},
	})
}

func TestRenderPatchContainsOneSecretFreeGatewayProvider(t *testing.T) {
	provider := testGatewayProvider()
	patch, err := RenderPatch(PatchInput{Providers: []Provider{provider}, SelectedModel: GatewayProviderID + "/codebuddy/hy4-preview-ioa", Version: ProtocolVersion})
	if err != nil {
		t.Fatal(err)
	}
	raw := string(patch)
	for _, expected := range []string{"wrenyard:\n", "apiKeyEnv: WRENYARD_GATEWAY_TOKEN\n", "id: codebuddy/hy4-preview-ioa\n", "name: \"HY4 Preview\"\n"} {
		if !strings.Contains(raw, expected) {
			t.Fatalf("patch missing %q:\n%s", expected, raw)
		}
	}
	for _, forbidden := range []string{"api.kimi.com", "open.bigmodel.cn", "local-secret"} {
		if strings.Contains(raw, forbidden) {
			t.Fatalf("patch leaked %q", forbidden)
		}
	}
}

func TestGatewayCredentialIsChildOnly(t *testing.T) {
	provider := testGatewayProvider()
	credential := TypedCredential{Token: "local-secret"}
	if err := ValidateCredential(provider, credential); err != nil {
		t.Fatal(err)
	}
	patch, err := RenderPatch(PatchInput{Providers: []Provider{provider}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(patch), credential.Token) {
		t.Fatal("Gateway token leaked into patch")
	}
	if got := LaunchEnv(provider, credential, []string{"Z=1"}); !reflect.DeepEqual(got, []string{"WRENYARD_GATEWAY_TOKEN=local-secret", "Z=1"}) {
		t.Fatalf("launch env = %v", got)
	}
}

func TestRenderRejectsMissingProviderAndUnknownSelection(t *testing.T) {
	if _, err := RenderPatch(PatchInput{}); err == nil {
		t.Fatal("missing daemon Gateway provider was accepted")
	}
	if _, err := RenderPatch(PatchInput{Providers: []Provider{testGatewayProvider()}, SelectedModel: GatewayProviderID + "/unknown/model"}); err == nil {
		t.Fatal("unknown model selection was accepted")
	}
}
