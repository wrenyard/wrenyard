package install

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestMigrateProvidersIntoConfigPreservesDaemonOwnedRuntimeAliases(t *testing.T) {
	dir := t.TempDir()
	providersPath := filepath.Join(dir, "providers.json")
	configPath := filepath.Join(dir, "config.json")
	providers := `{
		"schema_version": 1,
		"providers": {
			"legacy": {"api_kind": "openai", "models": [{"name": "legacy-model"}]}
		}
	}`
	config := `{
		"revision": 9,
		"aliases": {"codex-sol": "codex/gpt-5.6-sol:codex"},
		"clients": {"codex": {"enabled": true}}
	}`
	if err := os.WriteFile(providersPath, []byte(providers), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := MigrateProvidersIntoConfig(providersPath, configPath); err != nil {
		t.Fatalf("MigrateProvidersIntoConfig: %v", err)
	}

	raw, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]json.RawMessage
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("parse migrated config: %v", err)
	}
	var aliases map[string]string
	if err := json.Unmarshal(got["aliases"], &aliases); err != nil {
		t.Fatalf("parse migrated aliases: %v", err)
	}
	if string(got["revision"]) != "9" || aliases["codex-sol"] != "codex/gpt-5.6-sol:codex" || len(aliases) != 1 {
		t.Fatalf("migration changed daemon-owned alias state: %s", raw)
	}
	if _, ok := got["clients"]; !ok {
		t.Fatal("migration dropped existing Forge config fields")
	}
	if _, ok := got["provider"]; !ok {
		t.Fatal("migration did not add legacy provider data")
	}
}
