// Package config owns the ForgeConfig domain types and pure default-filling
// logic. It deliberately does not import the root forge package so that the
// root package can depend on it without a cycle.
package config

import "encoding/json"

// ClientEnabledReason describes why a client is or isn't usable.
type ClientEnabledReason string

const (
	ClientOK                 ClientEnabledReason = "ok"
	ClientDisabledByConfig   ClientEnabledReason = "disabled_by_config"
	ClientBinaryMissing      ClientEnabledReason = "binary_missing"
	ClientCredentialsMissing ClientEnabledReason = "credentials_missing"
)

// Config is the unified forge configuration — thin override schema only.
// Unknown legacy fields, including the retired top-level profiles recipe
// surface, are rejected at load time by strict JSON decoding.
type Config struct {
	Clients           map[string]Client           `json:"clients"`
	Providers         map[string]ProviderOverride `json:"providers,omitempty"`
	Quota             Quota                       `json:"quota"`
	CustomProviders   map[string]CustomProvider   `json:"custom_providers,omitempty"`
	GeneratedFrom     string                      `json:"_generated_from,omitempty"`
	PolicyMaxUsagePct map[string]int              `json:"policy_max_usage_pct,omitempty"`
	// RuntimeAliasRevision and RuntimeAliases belong to the daemon-owned alias
	// store that shares this top-level document. Forge recognizes them so its
	// strict decoder can coexist with the store, but never interprets alias
	// targets or uses them as execution profiles.
	RuntimeAliasRevision int64                      `json:"revision,omitempty"`
	RuntimeAliases       map[string]json.RawMessage `json:"aliases,omitempty"`
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

// IsClientEnabled reports whether a client is enabled (default true when the
// client is not present in the config).
func (c *Config) IsClientEnabled(client string) bool {
	if cc, ok := c.Clients[client]; ok {
		return cc.Enabled
	}
	return true
}
