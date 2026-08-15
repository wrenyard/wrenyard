package doctor

import (
	"path/filepath"
	"testing"
)

func TestCodebuddyAuthPaths(t *testing.T) {
	home := filepath.Join("home", "user")
	tests := []struct {
		goos, localAppData, want string
	}{
		{"darwin", "", filepath.Join(home, "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth", "Tencent-Cloud.coding-copilot.info")},
		{"linux", "", filepath.Join(home, ".local", "share", "CodeBuddyExtension", "Data", "Public", "auth", "Tencent-Cloud.coding-copilot.info")},
		{"windows", filepath.Join("C:", "Local"), filepath.Join("C:", "Local", "CodeBuddyExtension", "Data", "Public", "auth", "Tencent-Cloud.coding-copilot.info")},
	}
	for _, tt := range tests {
		if got := codebuddyAuthPath(tt.goos, home, tt.localAppData); got != tt.want {
			t.Fatalf("codebuddyAuthPath(%s) = %q, want %q", tt.goos, got, tt.want)
		}
	}
}

func TestCodebuddyCLIDoctorCheckSSOTFalseOverridesExistingFile(t *testing.T) {
	// When ProviderAuthStatus returns false, the doctor must report warning
	// even if the native auth file exists. This proves the SSOT can
	// override presence-only checks.
	deps := Dependencies{
		CodebuddyShimPath: func() string { return "/fake/bin/codebuddy" },
		Exists:            func(string) bool { return true },
		ProviderAuthStatus: func(providerID string) ProviderAuthState {
			if providerID == "codebuddy" {
				return ProviderAuthState{OK: false, SourcePath: "/fake/path/auth.json"}
			}
			return ProviderAuthState{OK: false}
		},
	}
	// ProviderAuthStatus is non-nil, so the SSOT path is used.
	// Even though Exists returns true for the file, the SSOT false causes
	// a warning. The response must not include any credential value.
	check := CodebuddyCLIDoctorCheck(deps)
	if check["status"] != "warning" {
		t.Fatalf("SSOT false should warn even when file exists, got status=%v", check["status"])
	}
	details, ok := check["details"].(map[string]interface{})
	if !ok {
		t.Fatalf("missing details: %#v", check)
	}
	if _, ok := details["credentials"]; ok {
		t.Fatalf("must not include credentials field when SSOT reports not ok: %#v", details)
	}
	if _, ok := details["credentials_error"]; ok {
		t.Fatalf("must not include credentials_error field: %#v", details)
	}
	if v, ok := details["credentials_path"]; !ok || v != "/fake/path/auth.json" {
		t.Fatalf("expected credentials_path=/fake/path/auth.json, got %#v", details)
	}
}

func TestCodebuddyCLIDoctorCheckSSOTTrueReportsOK(t *testing.T) {
	deps := Dependencies{
		CodebuddyShimPath: func() string { return "/fake/bin/codebuddy" },
		Exists:            func(string) bool { return true },
		ProviderAuthStatus: func(providerID string) ProviderAuthState {
			if providerID == "codebuddy" {
				return ProviderAuthState{OK: true, SourcePath: "/fake/path/auth.json"}
			}
			return ProviderAuthState{OK: false}
		},
	}
	check := CodebuddyCLIDoctorCheck(deps)
	if check["status"] != "ok" {
		t.Fatalf("SSOT true should report ok, got status=%v", check["status"])
	}
	details, ok := check["details"].(map[string]interface{})
	if !ok {
		t.Fatalf("missing details: %#v", check)
	}
	if v, ok := details["credentials"]; !ok || v != "present" {
		t.Fatalf("expected credentials=present, got %#v", details)
	}
	if v, ok := details["credentials_path"]; !ok || v != "/fake/path/auth.json" {
		t.Fatalf("expected credentials_path=/fake/path/auth.json, got %#v", details)
	}
}
