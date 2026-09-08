// Package selection owns profile availability, policy
// resolution, tier selection, and shortcut capability decisions. It
// deliberately does not import the root forge package; it uses neutral
// DTOs and an explicit Dependencies callback struct.
package selection

import "github.com/wrenyard/wrenyard/runtime/forge/internal/profiles/config"

// ClientEnabledReason describes why a client is or isn't usable.
type ClientEnabledReason = config.ClientEnabledReason

const (
	ClientOK                 = config.ClientOK
	ClientDisabledByConfig   = config.ClientDisabledByConfig
	ClientBinaryMissing      = config.ClientBinaryMissing
	ClientCredentialsMissing = config.ClientCredentialsMissing
)

// Profile is a neutral DTO carrying the subset of profile fields that the
// selection/availability logic depends on. The root package owns the full
// profile struct and maps to/from this DTO at the composition boundary.
type Profile struct {
	Name          string  `json:"name,omitempty"`
	Client        string  `json:"client"`
	Provider      string  `json:"provider"`
	SecretRef     *string `json:"secret_ref,omitempty"`
	Deprecated    bool    `json:"deprecated,omitempty"`
	Reason        string  `json:"reason,omitempty"`
	QuotaProvider string  `json:"quota_provider,omitempty"`
}

// Dependencies carries the external callbacks that selection functions need
// from the root forge package. Every callback mirrors a root-level function
// that the selection package cannot import directly.
type Dependencies struct {
	LoadForgeConfig     func() (config.Config, []string, error)
	ResolveCredential   func(providerID string) (string, bool)
	ResolveSecret       func(ref *string) (*string, error)
	LoadManifest        func() (map[string]Profile, error)
	ForgeDataDir        func() string
	ClientInstalled     func(client string) bool
	QuotaDisplayEnabled func(name string) bool
}
