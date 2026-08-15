// Package config owns the ForgeConfig domain types and pure default-filling
// logic. It deliberately does not import the root forge package so that the
// root package can depend on it without a cycle.
package config

import (
	"fmt"
	"strings"
)

// ClientEnabledReason describes why a client is or isn't usable.
type ClientEnabledReason string

const (
	ClientOK                 ClientEnabledReason = "ok"
	ClientDisabledByConfig   ClientEnabledReason = "disabled_by_config"
	ClientBinaryMissing      ClientEnabledReason = "binary_missing"
	ClientCredentialsMissing ClientEnabledReason = "credentials_missing"
)

// Config is the unified forge configuration — thin override schema only.
// Unknown legacy fields are rejected at load time.
type Config struct {
	Clients           map[string]Client           `json:"clients"`
	Providers         map[string]ProviderOverride `json:"providers,omitempty"`
	Profiles          map[string]ProfileRecipe    `json:"profiles,omitempty"`
	Quota             Quota                       `json:"quota"`
	CustomProviders   map[string]CustomProvider   `json:"custom_providers,omitempty"`
	LLMModel          string                      `json:"llm_model,omitempty"`
	LLMProtocol       string                      `json:"llm_protocol,omitempty"`
	GeneratedFrom     string                      `json:"_generated_from,omitempty"`
	PolicyMaxUsagePct map[string]int              `json:"policy_max_usage_pct,omitempty"`
}

// ProfileRecipe is the intentionally small custom-profile surface. Strict JSON
// decoding rejects launcher/env/access and every other definition-like field.
type ProfileRecipe struct {
	Client       string   `json:"client"`
	Provider     string   `json:"provider"`
	Model        string   `json:"model"`
	Description  string   `json:"description,omitempty"`
	Capabilities []string `json:"capabilities,omitempty"`
}

// Client holds per-client configuration.
type Client struct {
	Enabled bool `json:"enabled"`
}

// CustomProvider describes a user-defined provider binding. Custom providers
// are data-only: they carry no inference endpoint or API key of their own.
// Credentials are inherited from the client's default native credential
// source, and the binding always runs through the client binary.
type CustomProvider struct {
	Client string   `json:"client"`
	Models []string `json:"models"`
}

// Quota holds quota cache TTL configuration.
type Quota struct {
	StatuslineTTLSec   int `json:"statusline_ttl_sec"`
	UsageTTLMin        int `json:"usage_ttl_min"`
	SnapshotStaleMin   int `json:"snapshot_stale_min"`
	StatuslineRenderMs int `json:"statusline_render_ms,omitempty"`
	StatuslineFetchSec int `json:"statusline_fetch_sec,omitempty"`
}

// ValidateCapabilities checks that each capability name is non-empty after
// trimming, preserves declared order, and rejects duplicates. It returns the
// validated, trimmed slice with duplicates removed.
func ValidateCapabilities(caps []string) ([]string, error) {
	if len(caps) == 0 {
		return nil, nil
	}
	seen := make(map[string]bool, len(caps))
	out := make([]string, 0, len(caps))
	for _, raw := range caps {
		name := strings.TrimSpace(raw)
		if name == "" {
			return nil, fmt.Errorf("capability name must not be empty")
		}
		if seen[name] {
			return nil, fmt.Errorf("duplicate capability %q", name)
		}
		seen[name] = true
		out = append(out, name)
	}
	return out, nil
}

// IsClientEnabled reports whether a client is enabled (default true when the
// client is not present in the config).
func (c *Config) IsClientEnabled(client string) bool {
	if cc, ok := c.Clients[client]; ok {
		return cc.Enabled
	}
	return true
}
