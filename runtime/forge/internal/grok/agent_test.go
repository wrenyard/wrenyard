package grok

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

func TestAgentConfigMaterializesGatewayProjectionWithoutSecrets(t *testing.T) {
	projection := ProjectModel(
		"kimi-coding",
		"http://127.0.0.1:1234/gateway/openai-chat/v1/chat/completions",
		catalog.ModelDef{ID: "k3", DisplayName: "Kimi K3", ContextWindow: 1048576},
	)
	projection.Model = "kimi-coding/k3"
	projection.EnvKey = "WRENYARD_GATEWAY_TOKEN"
	data, err := AgentConfigBytes([]Projection{projection}, projection.ID)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	if !strings.Contains(text, projection.ID) {
		t.Fatalf("agent config missing Gateway projection %q:\n%s", projection.ID, text)
	}
	if !strings.Contains(text, `default = 'forge-kimi-coding--k3'`) {
		t.Fatalf("agent config does not select the profile model as default:\n%s", text)
	}
	if !strings.Contains(text, `session_summary = 'forge-kimi-coding--k3'`) {
		t.Fatalf("agent config does not keep session summaries on the profile model:\n%s", text)
	}
	if strings.Contains(strings.ToLower(text), "api_key =") || strings.Contains(text, "present") {
		t.Fatalf("agent config contains credential material:\n%s", text)
	}
}

func TestOAuthSourcePrecedenceAndByteCopyInput(t *testing.T) {
	root := t.TempDir()
	forgeData := filepath.Join(root, "data", "wrenyard", "runtime")
	home := filepath.Join(root, "home")
	shellAuth := filepath.Join(forgeData, "grok", "shell-grok", "auth.json")
	defaultAuth := filepath.Join(home, ".grok", "auth.json")
	if err := os.MkdirAll(filepath.Dir(shellAuth), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(defaultAuth), 0o700); err != nil {
		t.Fatal(err)
	}
	shellBytes := []byte("shell-auth-\x00-exact")
	defaultBytes := []byte("default-auth-different")
	if err := os.WriteFile(shellAuth, shellBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(defaultAuth, defaultBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	selected, err := SelectOAuthSource(forgeData, home)
	if err != nil || selected != shellAuth {
		t.Fatalf("selected = %q err=%v, want shell source", selected, err)
	}
	prepared, err := PrepareOAuth(forgeData, home)
	if err != nil || prepared.SourcePath != shellAuth || len(prepared.ReadablePaths) != 2 ||
		prepared.ReadablePaths[0] != shellAuth || prepared.ReadablePaths[1] != defaultAuth {
		t.Fatalf("prepared OAuth sources = %+v err=%v", prepared, err)
	}
	before, _ := os.ReadFile(shellAuth)
	if !bytes.Equal(before, shellBytes) {
		t.Fatal("source bytes changed during read-only probe")
	}
	if err := os.Remove(shellAuth); err != nil {
		t.Fatal(err)
	}
	selected, err = SelectOAuthSource(forgeData, home)
	if err != nil || selected != defaultAuth {
		t.Fatalf("fallback selected = %q err=%v, want official default", selected, err)
	}
	prepared, err = PrepareOAuth(forgeData, home)
	if err != nil || prepared.SourcePath != defaultAuth || len(prepared.ReadablePaths) != 1 || prepared.ReadablePaths[0] != defaultAuth {
		t.Fatalf("fallback prepared OAuth sources = %+v err=%v", prepared, err)
	}
}

func TestMissingOAuthErrorContainsNoFileContent(t *testing.T) {
	root := t.TempDir()
	_, err := SelectOAuthSource(filepath.Join(root, "data"), filepath.Join(root, "home"))
	if err == nil || !strings.Contains(err.Error(), "missing") {
		t.Fatalf("missing OAuth error = %v", err)
	}
	if strings.Contains(err.Error(), "token") || strings.Contains(err.Error(), "secret") {
		t.Fatalf("OAuth error should remain content-free: %v", err)
	}
}
