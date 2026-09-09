package config

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadForgeConfigRejectsUnknownKey(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	data := `{"clients": {"claude": {"enabled": true}}, "bogus_key": true}`
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
	_, _, err := LoadForgeConfig(path, EmbeddedData(), &bytes.Buffer{})
	if err == nil {
		t.Fatal("expected error for unknown key (strict schema)")
	}
}

func TestLoadForgeConfigRejectsLegacyTopLevelProfiles(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	data := `{
		"clients": {"codebuddy": {"enabled": true}},
		"profiles": {
			"cb-hy": {"client": "codebuddy", "provider": "codebuddy", "model": "hy4-preview"}
		}
	}`
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
	_, _, err := LoadForgeConfig(path, EmbeddedData(), &bytes.Buffer{})
	if err == nil {
		t.Fatal("expected error for legacy top-level profiles key (strict schema)")
	}
}

func TestLoadForgeConfigAcceptsDaemonOwnedRuntimeAliasFieldsWithoutInterpretingThem(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	data := `{
		"revision": 7,
		"aliases": {
			"codex-sol": "codex/gpt-5.6-sol:codex",
			"invalid-entry-preserved-for-daemon": {"unexpected": true}
		},
		"clients": {"codex": {"enabled": false}}
	}`
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, _, err := LoadForgeConfig(path, EmbeddedData(), &bytes.Buffer{})
	if err != nil {
		t.Fatalf("LoadForgeConfig with daemon-owned alias fields: %v", err)
	}
	if cfg.RuntimeAliasRevision != 7 {
		t.Fatalf("RuntimeAliasRevision = %d, want 7", cfg.RuntimeAliasRevision)
	}
	if len(cfg.RuntimeAliases) != 2 {
		t.Fatalf("RuntimeAliases len = %d, want 2", len(cfg.RuntimeAliases))
	}
	if cfg.IsClientEnabled("codex") {
		t.Fatal("existing Forge config fields must still load beside daemon-owned aliases")
	}
	roundTrip, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("marshal shared config: %v", err)
	}
	var persisted map[string]json.RawMessage
	if err := json.Unmarshal(roundTrip, &persisted); err != nil {
		t.Fatalf("parse round-tripped shared config: %v", err)
	}
	if string(persisted["revision"]) != "7" {
		t.Fatalf("round-tripped revision = %s, want 7", persisted["revision"])
	}
	var aliases map[string]json.RawMessage
	if err := json.Unmarshal(persisted["aliases"], &aliases); err != nil {
		t.Fatalf("parse round-tripped aliases: %v", err)
	}
	if string(aliases["codex-sol"]) != `"codex/gpt-5.6-sol:codex"` || string(aliases["invalid-entry-preserved-for-daemon"]) != `{"unexpected":true}` {
		t.Fatalf("round-tripped aliases changed: %s", persisted["aliases"])
	}
}

func TestLoadForgeConfigAcceptsCustomProviders(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	data := `{
		"clients": {"codebuddy": {"enabled": true}},
		"custom_providers": {
			"codebuddy-local": {"client": "codebuddy", "models": ["deepseek-v4-flash", "deepseek-v4-pro"]}
		}
	}`
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, _, err := LoadForgeConfig(path, EmbeddedData(), &bytes.Buffer{})
	if err != nil {
		t.Fatalf("LoadForgeConfig with custom_providers: %v", err)
	}
	provider, ok := cfg.CustomProviders["codebuddy-local"]
	if !ok {
		t.Fatal("expected codebuddy-local custom provider")
	}
	if provider.Client != "codebuddy" {
		t.Fatalf("custom provider client = %q, want codebuddy", provider.Client)
	}
	if len(provider.Models) != 2 || provider.Models[0] != "deepseek-v4-flash" || provider.Models[1] != "deepseek-v4-pro" {
		t.Fatalf("custom provider models = %#v, want [deepseek-v4-flash deepseek-v4-pro]", provider.Models)
	}
}

func TestLoadForgeConfigRejectsCustomProviderUnknownField(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	data := `{
		"custom_providers": {
			"bad": {"client": "codebuddy", "models": ["deepseek-v4-flash"], "api_key": "secret"}
		}
	}`
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
	_, _, err := LoadForgeConfig(path, EmbeddedData(), &bytes.Buffer{})
	if err == nil {
		t.Fatal("expected error for unknown field api_key on custom provider")
	}
}
