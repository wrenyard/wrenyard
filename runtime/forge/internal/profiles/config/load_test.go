package config

import (
	"bytes"
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
