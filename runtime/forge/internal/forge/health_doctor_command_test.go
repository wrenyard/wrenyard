package forge

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestDoctorRejectsRemovedCCBTarget(t *testing.T) {
	stderr := captureStderr(t, func() {
		if code := Run([]string{"doctor", "ccb", "--json"}, "forge"); code != 2 {
			t.Fatalf("expected removed doctor target to exit 2, got %d", code)
		}
	})
	if !strings.Contains(stderr, `unknown target "ccb"`) {
		t.Fatalf("expected unknown target error for removed ccb target, got: %s", stderr)
	}
}

func TestDoctorReportsSecretsStatus(t *testing.T) {
	repo := t.TempDir()
	home := t.TempDir()
	t.Setenv("FORGE_REPO_DIR", repo)
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", "")

	check := secretsDoctorCheck()
	if check["status"] != "warning" {
		t.Fatalf("missing user secrets should warn, got %v", check)
	}

	configDir := filepath.Join(home, ".config", "wrenyard", "runtime")
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configDir, "secrets.json"), []byte(`{"key":"val"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	// Create auth.json with all credentials so doctor reports "ok".
	dataDir := filepath.Join(home, ".local", "share", "wrenyard", "runtime")
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		t.Fatal(err)
	}
	authJSON := `{"zhipu-coding": {"type": "api", "key": "test-key"}, "kimi-coding": {"type": "api", "key": "test-key"}, "deepseek": {"type": "api", "key": "test-key"}, "anthropic": {"type": "api", "key": "test-key"}}`
	if err := os.WriteFile(filepath.Join(dataDir, "auth.json"), []byte(authJSON), 0o600); err != nil {
		t.Fatal(err)
	}

	check = secretsDoctorCheck()
	if check["status"] != "ok" {
		t.Fatalf("correct user secrets should be ok, got %v", check)
	}
}

func TestDoctorReportsSecretsPermsWarning(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows does not enforce Unix permission bits")
	}
	repo := t.TempDir()
	home := t.TempDir()
	t.Setenv("FORGE_REPO_DIR", repo)
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", "")

	configDir := filepath.Join(home, ".config", "wrenyard", "runtime")
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configDir, "secrets.json"), []byte(`{}`), 0o644); err != nil {
		t.Fatal(err)
	}

	check := secretsDoctorCheck()
	if check["status"] != "warning" {
		t.Fatalf("incorrect permissions should warn, got %v", check)
	}
	details, ok := check["details"].(map[string]any)
	if !ok {
		t.Fatalf("incorrect permissions should include a nested details map, got %v", check)
	}
	if details["secrets_exists"] != true {
		t.Fatalf("secrets should exist for the permissions check, got %v", details)
	}
	if details["secrets_perms_ok"] != false {
		t.Fatalf("loose permissions should be flagged, got %v", details)
	}
}
