// Package manifest owns the profile and manifest type definitions shared across
// Forge profile consumers.
package manifest

// Profile is a single profile definition as stored on disk.
type Profile struct {
	Name            string            `json:"name,omitempty"`
	Client          string            `json:"client"`
	Provider        string            `json:"provider"`
	SecretRef       *string           `json:"secret_ref"`
	Launcher        map[string]any    `json:"launcher"`
	Env             map[string]string `json:"env"`
	Settings        map[string]any    `json:"settings"`
	Statusline      *StatuslineConfig `json:"statusline,omitempty"`
	Supports1M      bool              `json:"supports_1m,omitempty"`
	Deprecated      bool              `json:"deprecated,omitempty"`
	Reason          string            `json:"reason,omitempty"`
	Description     string            `json:"description"`
	TaskDescription string            `json:"task_description"`
	RequiresPlugin  *string           `json:"requires_plugin,omitempty"`
	GeneratedFrom   string            `json:"_generated_from,omitempty"`
	Capabilities    []string          `json:"capabilities,omitempty"`
}

// Manifest is the top-level profiles manifest.
type Manifest struct {
	SchemaVersion int                `json:"schema_version"`
	Profiles      map[string]Profile `json:"profiles"`
	OrderedIDs    []string           `json:"-"`
}

// StatuslineConfig holds per-profile statusline rendering settings.
type StatuslineConfig struct {
	Segments      []string `json:"segments,omitempty"`
	QuotaProvider string   `json:"quota_provider,omitempty"`
	Billing       string   `json:"billing,omitempty"`
	MaxWidth      int      `json:"max_width,omitempty"`
}
