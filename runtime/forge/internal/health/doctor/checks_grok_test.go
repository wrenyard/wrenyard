package doctor

import (
	"os"
	"path/filepath"
	"testing"
)

func TestGrokDoctorCheckReportsNativeRuntime(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "home")
	data := filepath.Join(root, "data")
	authPath := filepath.Join(home, ".grok", "auth.json")
	if err := os.MkdirAll(filepath.Dir(authPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(authPath, []byte(`{"token":"secret"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDG_DATA_HOME", data)
	result := GrokDoctorCheck(Dependencies{
		UserHome:            func() string { return home },
		GrokBinaryInstalled: func() bool { return true },
	})
	if result["status"] != "ok" {
		t.Fatalf("status = %v, want ok: %#v", result["status"], result)
	}
	details := result["details"].(map[string]interface{})
	if details["binary_installed"] != true || details["spacex_ai_oauth_available"] != true {
		t.Fatalf("details = %#v", details)
	}
	if _, exists := details["eligible_models"]; exists {
		t.Fatal("doctor must not expose retired direct-provider projections")
	}
}

func TestGrokDoctorCheckMissingNativeInputsWarns(t *testing.T) {
	root := t.TempDir()
	t.Setenv("XDG_DATA_HOME", filepath.Join(root, "data"))
	result := GrokDoctorCheck(Dependencies{
		UserHome:            func() string { return filepath.Join(root, "home") },
		GrokBinaryInstalled: func() bool { return false },
	})
	if result["status"] != "warning" {
		t.Fatalf("status = %v, want warning: %#v", result["status"], result)
	}
}
