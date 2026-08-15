package doctor

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestCodexConfigCheckSSOTFalseForMalformedJSON(t *testing.T) {
	// When ProviderAuthStatus returns false for malformed native auth,
	// the doctor must report warning even if the auth file exists.
	home := t.TempDir()
	t.Setenv("HOME", home)
	bin := t.TempDir()
	t.Setenv("PATH", bin)

	// Write fake codex binary on PATH.
	codexPath := fakeCodexBinaryPath(bin)
	if err := os.WriteFile(codexPath, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	deps := Dependencies{
		UserHome: func() string { return home },
		ProviderAuthStatus: func(providerID string) ProviderAuthState {
			if providerID == "codex" {
				return ProviderAuthState{OK: false, SourcePath: filepath.Join(home, ".codex", "auth.json")}
			}
			return ProviderAuthState{OK: false}
		},
	}
	check := CodexConfigCheck(deps)
	if check["status"] != "warning" {
		t.Fatalf("SSOT false for malformed auth should warn, got status=%v: %v", check["status"], check["message"])
	}
	details, ok := check["details"].(map[string]interface{})
	if !ok {
		t.Fatalf("missing details: %#v", check)
	}
	if details["binary"] != codexPath {
		t.Fatalf("expected binary=%s, got %v", codexPath, details["binary"])
	}
	if _, ok := details["auth_path"]; !ok {
		t.Fatalf("missing auth_path in details: %#v", details)
	}
	// No credential values in report.
	if _, ok := details["credentials"]; ok {
		t.Fatalf("must not include credentials field: %#v", details)
	}
}

func TestCodexConfigCheckSSOTTrueReportsOK(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	bin := t.TempDir()
	t.Setenv("PATH", bin)

	codexPath := fakeCodexBinaryPath(bin)
	if err := os.WriteFile(codexPath, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	deps := Dependencies{
		UserHome: func() string { return home },
		ProviderAuthStatus: func(providerID string) ProviderAuthState {
			if providerID == "codex" {
				return ProviderAuthState{OK: true, SourcePath: filepath.Join(home, ".codex", "auth.json")}
			}
			return ProviderAuthState{OK: false}
		},
	}
	check := CodexConfigCheck(deps)
	if check["status"] != "ok" {
		t.Fatalf("SSOT true should report ok, got status=%v: %v", check["status"], check["message"])
	}
	details, ok := check["details"].(map[string]interface{})
	if !ok {
		t.Fatalf("missing details: %#v", check)
	}
	if _, ok := details["auth_path"]; !ok {
		t.Fatalf("missing auth_path in details: %#v", details)
	}
}

func TestCodexConfigCheckSSOTFalseForExistingEmptyFile(t *testing.T) {
	// SSOT false when auth file exists but is empty — proves the SSOT
	// validates content, not just presence.
	home := t.TempDir()
	t.Setenv("HOME", home)
	bin := t.TempDir()
	t.Setenv("PATH", bin)

	codexPath := fakeCodexBinaryPath(bin)
	if err := os.WriteFile(codexPath, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	// Create an empty auth.json file.
	codexDir := filepath.Join(home, ".codex")
	if err := os.MkdirAll(codexDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(codexDir, "auth.json"), []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}

	deps := Dependencies{
		UserHome: func() string { return home },
		ProviderAuthStatus: func(providerID string) ProviderAuthState {
			if providerID == "codex" {
				return ProviderAuthState{OK: false, SourcePath: filepath.Join(home, ".codex", "auth.json")}
			}
			return ProviderAuthState{OK: false}
		},
	}
	check := CodexConfigCheck(deps)
	if check["status"] != "warning" {
		t.Fatalf("SSOT false for empty auth file should warn, got status=%v: %v", check["status"], check["message"])
	}
}

func TestCodexConfigCheckAbsentCallbackFallsBack(t *testing.T) {
	// When ProviderAuthStatus is nil, the legacy file-existence fallback
	// is used (for isolated callers without the SSOT).
	home := t.TempDir()
	t.Setenv("HOME", home)
	bin := t.TempDir()
	t.Setenv("PATH", bin)

	codexPath := fakeCodexBinaryPath(bin)
	if err := os.WriteFile(codexPath, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	deps := Dependencies{
		UserHome:           func() string { return home },
		ProviderAuthStatus: nil,
		Exists:             func(path string) bool { return true },
	}
	check := CodexConfigCheck(deps)
	if check["status"] != "ok" {
		t.Fatalf("legacy fallback with existing file should report ok, got status=%v: %v", check["status"], check["message"])
	}
}

func fakeCodexBinaryPath(dir string) string {
	name := "codex"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return filepath.Join(dir, name)
}
