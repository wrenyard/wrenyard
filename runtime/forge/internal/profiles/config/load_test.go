package config

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestFillDefaultsLLMConfig(t *testing.T) {
	var cfg Config
	FillDefaults(&cfg, EmbeddedData())
	if cfg.LLMModel != "" {
		t.Fatalf("LLMModel default = %q, want empty (no internal default)", cfg.LLMModel)
	}
	if cfg.LLMProtocol != "openai" {
		t.Fatalf("LLMProtocol default = %q, want openai", cfg.LLMProtocol)
	}
	if cfg.CustomProviders == nil {
		t.Fatal("CustomProviders must be initialized to an empty map")
	}
	if len(cfg.CustomProviders) != 0 {
		t.Fatalf("CustomProviders must default empty, got %#v", cfg.CustomProviders)
	}
}

func TestLoadForgeConfigLLMDecoding(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	data := `{
		"clients": {"claude": {"enabled": true}},
		"llm_model": "kimi-coding/k3",
		"llm_protocol": "anthropic"
	}`
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, _, err := LoadForgeConfig(path, EmbeddedData(), &bytes.Buffer{})
	if err != nil {
		t.Fatalf("LoadForgeConfig: %v", err)
	}
	if cfg.LLMModel != "kimi-coding/k3" {
		t.Fatalf("LLMModel = %q, want kimi-coding/k3", cfg.LLMModel)
	}
	if cfg.LLMProtocol != "anthropic" {
		t.Fatalf("LLMProtocol = %q, want anthropic", cfg.LLMProtocol)
	}
	if cfg.Quota.StatuslineTTLSec != 600 {
		t.Fatalf("StatuslineTTLSec = %d, want 600 (unrelated default must still apply)", cfg.Quota.StatuslineTTLSec)
	}
}

func TestLoadForgeConfigLLMDefaultsWhenMissing(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	data := `{"clients": {"claude": {"enabled": true}}}`
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, _, err := LoadForgeConfig(path, EmbeddedData(), &bytes.Buffer{})
	if err != nil {
		t.Fatalf("LoadForgeConfig: %v", err)
	}
	if cfg.LLMModel != "" {
		t.Fatalf("LLMModel = %q, want empty (no internal default)", cfg.LLMModel)
	}
	if cfg.LLMProtocol != "openai" {
		t.Fatalf("LLMProtocol = %q, want openai", cfg.LLMProtocol)
	}
}

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
