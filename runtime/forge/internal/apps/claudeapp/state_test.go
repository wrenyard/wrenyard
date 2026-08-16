package claudeapp

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func exists(path string) bool { _, err := os.Stat(path); return err == nil }

func TestReadOrCreateStateGeneratesAndPersistsKey(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_STATE_HOME", filepath.Join(home, "xdg-state"))
	t.Setenv("LOCALAPPDATA", "")

	state, path, err := ReadOrCreateState()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(state.GatewayAPIKey, "forge_") {
		t.Fatalf("expected generated state key with forge_ prefix, got %q", state.GatewayAPIKey)
	}
	// Gateway state resolves beneath wrenyard/runtime and never leaks the key.
	wantPath := filepath.Join(home, "xdg-state", "wrenyard", "runtime", stateFileName)
	if path != wantPath {
		t.Fatalf("state path = %q, want %q", path, wantPath)
	}
	if strings.Contains(path, state.GatewayAPIKey) {
		t.Fatal("state path must not leak the generated gateway key")
	}
	// ReadOrCreateState generates the key in memory and returns the intended
	// path but does NOT persist the file itself.
	if exists(path) {
		t.Fatalf("state file should not be created by ReadOrCreateState at %s", path)
	}

	if err := WriteState(path, state); err != nil {
		t.Fatal(err)
	}
	if !exists(path) {
		t.Fatalf("state file should exist after WriteState at %s", path)
	}
	persisted := readJSONMap(path)
	if persisted["gateway_api_key"] != state.GatewayAPIKey {
		t.Fatalf("persisted gateway_api_key = %#v, want %#v", persisted["gateway_api_key"], state.GatewayAPIKey)
	}

	again, _, err := ReadOrCreateState()
	if err != nil {
		t.Fatal(err)
	}
	if again.GatewayAPIKey != state.GatewayAPIKey {
		t.Fatalf("re-read state should preserve key, got %q want %q", again.GatewayAPIKey, state.GatewayAPIKey)
	}
}

func TestNewGatewayKeyIs32ByteHexPrefixed(t *testing.T) {
	key, err := newGatewayKey()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(key, "forge_") {
		t.Fatalf("gateway key should be prefixed forge_, got %q", key)
	}
	raw := strings.TrimPrefix(key, "forge_")
	if len(raw) != 48 {
		t.Fatalf("expected 24-byte hex (48 chars), got %d chars in %q", len(raw), raw)
	}
}

func TestStatePathDefaultUnderWrenyardRuntime(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_STATE_HOME", "")
	t.Setenv("LOCALAPPDATA", "")

	path, err := statePath()
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(home, ".local", "state", "wrenyard", "runtime", stateFileName)
	if path != want {
		t.Fatalf("statePath() = %q, want %q", path, want)
	}
}

func TestLocalConfigReplacesConfigLibrary(t *testing.T) {
	localAppData := t.TempDir()
	t.Setenv("LOCALAPPDATA", localAppData)
	cfg := Config{
		Profile:        Profile{Name: "ccg", Provider: "glm"},
		GatewayBaseURL: "http://127.0.0.1:18080",
		GatewayAPIKey:  "forge-token",
		Routes: []ModelRoute{
			{Name: sonnetID, DisplayName: sonnetID, Slot: "sonnet", UpstreamModel: "glm-5.3"},
		},
	}
	oldLibrary := filepath.Join(localAppData, "Claude-3p", "configLibrary")
	if err := os.MkdirAll(oldLibrary, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(oldLibrary, "_meta.json"), []byte(`{"appliedId":"old","entries":[{"id":"old","name":"CC Switch"}]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	staleSwitchConfig := filepath.Join(oldLibrary, "00000000-0000-4000-8000-000000157210.json")
	if err := os.WriteFile(staleSwitchConfig, []byte(`{"inferenceGatewayApiKey":"ccs-old","inferenceGatewayBaseUrl":"http://127.0.0.1:15721/claude-desktop"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	staleCCDSConfig := filepath.Join(oldLibrary, "d6911891-ee97-4e61-8bf2-0845a369e57f.json")
	if err := os.WriteFile(staleCCDSConfig, []byte(`{"inferenceGatewayApiKey":"ccds_old","inferenceGatewayBaseUrl":"http://127.0.0.1:18080","inferenceGatewayHeaders":{"x-api-key":"ccds_old"}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := ApplyLocalConfig(cfg); err != nil {
		t.Fatal(err)
	}

	meta := readJSONMap(filepath.Join(oldLibrary, "_meta.json"))
	if meta["appliedId"] != configLibraryID {
		t.Fatalf("expected Forge config library id, got %#v", meta)
	}
	entry := readJSONMap(filepath.Join(oldLibrary, configLibraryID+".json"))
	if entry["inferenceGatewayApiKey"] != "forge-token" || entry["inferenceGatewayBaseUrl"] != "http://127.0.0.1:18080" {
		t.Fatalf("local config library did not use Forge gateway: %#v", entry)
	}
	headers, ok := entry["inferenceGatewayHeaders"].(map[string]interface{})
	if !ok || headers["x-api-key"] != "forge-token" {
		t.Fatalf("local config library should include x-api-key gateway header: %#v", entry["inferenceGatewayHeaders"])
	}
	if exists(staleSwitchConfig) {
		t.Fatalf("stale CC Switch config should be removed: %s", staleSwitchConfig)
	}
	if exists(staleCCDSConfig) {
		t.Fatalf("stale CCDS switch config should be removed: %s", staleCCDSConfig)
	}
	config := readJSONMap(filepath.Join(localAppData, "Claude-3p", "claude_desktop_config.json"))
	if config["deploymentMode"] != "3p" {
		t.Fatalf("expected 3p deployment mode, got %#v", config)
	}
}

func TestApplyPolicyUsesLocalConfigOnNonWindows(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("Claude Desktop local policy path is supported on macOS; Windows uses registry policy")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	cfg := Config{
		Profile:        Profile{Name: "ccg", Provider: "glm"},
		GatewayBaseURL: "http://127.0.0.1:18080",
		GatewayAPIKey:  "forge-token",
		Routes: []ModelRoute{
			{Name: sonnetID, DisplayName: sonnetID, Slot: "sonnet", UpstreamModel: "glm-4.7"},
		},
	}

	if err := ApplyPolicy(cfg); err != nil {
		t.Fatal(err)
	}

	config := readJSONMap(filepath.Join(home, "Library", "Application Support", "Claude-3p", "claude_desktop_config.json"))
	if config["deploymentMode"] != "3p" {
		t.Fatalf("expected macOS Claude-3p config to be applied, got %#v", config)
	}
}

func TestLocalConfigPolicyReportsConfiguredOnNonWindows(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("Claude Desktop local policy status is supported on macOS; Windows uses registry policy")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	cfg := Config{
		Profile:        Profile{Name: "ccg", Provider: "glm"},
		GatewayBaseURL: "http://127.0.0.1:18080",
		GatewayAPIKey:  "forge-token",
		Routes: []ModelRoute{
			{Name: sonnetID, DisplayName: sonnetID, Slot: "sonnet", UpstreamModel: "glm-4.7"},
		},
	}
	if err := ApplyPolicy(cfg); err != nil {
		t.Fatal(err)
	}

	policy := QueryLocalConfigPolicy()
	if !localPolicyConfigured(policy) {
		t.Fatalf("expected local Claude app config to report configured, got %#v", policy)
	}
	if policy["inferenceGatewayHeaders"] != "******" {
		t.Fatalf("expected local gateway headers to be redacted, got %#v", policy["inferenceGatewayHeaders"])
	}
}

func localPolicyConfigured(policy map[string]interface{}) bool {
	provider, _ := policy["inferenceProvider"].(string)
	return provider == "gateway" && interfaceBoolishTrue(policy["forge_managed"])
}
