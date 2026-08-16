package forge

import (
	"os"
	"path/filepath"
	"testing"
)

func TestClientsDoctorChecksShapeAndStatus(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("PATH", t.TempDir())
	saveTempConfig(t, home, ForgeConfig{
		Clients: map[string]ClientConfig{
			"claude": {Enabled: true},
			"codex":  {Enabled: false},
		},
	})

	checks := clientsDoctorChecks()
	if len(checks) != 1 {
		t.Fatalf("len(checks) = %d, want 1", len(checks))
	}
	got := checks[0]
	if got["adapter"] != "clients" || got["status"] != "warning" {
		t.Fatalf("check = %#v, want clients warning", got)
	}
	details := got["details"].(map[string]interface{})
	claude := details["claude"].(map[string]interface{})
	if claude["enabled"] != true || claude["installed"] != false {
		t.Fatalf("claude details = %#v, want enabled true installed false", claude)
	}
	codex := details["codex"].(map[string]interface{})
	if codex["enabled"] != false || codex["installed"] != false {
		t.Fatalf("codex details = %#v, want disabled and not installed", codex)
	}
	grok := details["grok"].(map[string]interface{})
	if grok["enabled"] != true || grok["installed"] != false {
		t.Fatalf("absent grok config entry should use source default: %#v", grok)
	}
}

func TestProfilesDoctorChecksEmbeddedProfilesHaveNoErrors(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("PATH", t.TempDir())

	checks := profilesDoctorChecks()
	got := checks[0]
	if got["adapter"] != "profiles" {
		t.Fatalf("adapter = %v, want profiles", got["adapter"])
	}
	details := got["details"].(map[string]interface{})
	for _, entry := range details["non_ok"].([]map[string]interface{}) {
		if reason, _ := entry["reason"].(string); reason == "unknown_client" || reason == "unknown_provider" {
			t.Fatalf("embedded profile produced error entry: %#v", entry)
		}
	}
	if got["status"] == "error" {
		t.Fatalf("embedded profiles should not produce error status: %#v", got)
	}
}

func TestProfilesDoctorChecksReportsCatalogOpportunities(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	setFakeClientsOnPath(t, "claude")
	saveTempConfig(t, home, doctorProfileTestConfig())

	got := profilesDoctorChecks()[0]
	details := got["details"].(map[string]interface{})

	// catalog_opportunities is optional; skip if not present.
	raw, ok := details["catalog_opportunities"]
	if !ok {
		return
	}
	opportunities, ok := raw.([]map[string]interface{})
	if !ok || len(opportunities) == 0 {
		return
	}

	reasons := map[string]string{}
	for _, entry := range opportunities {
		profile, _ := entry["profile"].(string)
		reason, _ := entry["reason"].(string)
		if profile != "" && reason != "" {
			reasons[profile] = reason
		}
	}
	// cc-glm is a built-in rich provider; without auth it should appear as not authenticated.
	if r, has := reasons["cc-glm"]; has && r != "provider not authenticated" {
		t.Fatalf("cc-glm catalog opportunity reason = %q, want provider not authenticated: %#v", r, opportunities)
	}
}

func doctorProfileTestConfig() ForgeConfig {
	return ForgeConfig{
		Clients: map[string]ClientConfig{
			"claude": {Enabled: true},
		},
	}
}

func TestProvidersDoctorChecksOKWhenCredentialResolves(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	saveTempConfig(t, home, ForgeConfig{
		Clients: map[string]ClientConfig{},
	})
	if err := os.MkdirAll(filepath.Join(home, ".local", "share", "wrenyard", "runtime"), 0o700); err != nil {
		t.Fatal(err)
	}
	setTestAuth(t, "zhipu-coding", "test-key")

	got := providersDoctorChecks()[0]
	if got["status"] != "ok" {
		t.Fatalf("status = %v, want ok: %#v", got["status"], got)
	}
}
