package grok

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

func TestAgentConfigFullyMaterializesEligibleProjectionsWithoutSecrets(t *testing.T) {
	projections, _ := EligibleProjections(catalog.DefaultRegistry(), resolveSet("kimi-coding", "zhipu-coding"))
	data, err := AgentConfigBytes(projections, "forge-kimi-coding--k3")
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, id := range []string{"forge-kimi-coding--k3", "forge-zhipu-coding--glm-5-3"} {
		if !strings.Contains(text, id) {
			t.Fatalf("agent config missing eligible projection %q:\n%s", id, text)
		}
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
	forgeData := filepath.Join(root, "data", "forge")
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
