package doctor

import (
	"sort"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/profiles/config"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

// Profile is a neutral DTO for profile data needed by doctor checks.
type Profile struct {
	Client    string                 `json:"client"`
	Provider  string                 `json:"provider"`
	Launcher  map[string]interface{} `json:"launcher"`
	Env       map[string]string      `json:"env,omitempty"`
	SecretRef *string                `json:"secret_ref,omitempty"`
}

// ProfileManifest represents a loaded profile manifest for checks.
type ProfileManifest struct {
	SchemaVersion int                `json:"schema_version"`
	Profiles      map[string]Profile `json:"profiles"`
}

// Check builds a doctor-check map entry preserving exact map shape.
func Check(adapter, status, message string, missing []string, details map[string]interface{}) map[string]interface{} {
	data := map[string]interface{}{"adapter": adapter, "status": status, "message": message}
	if len(missing) > 0 {
		data["missing"] = missing
	}
	if details != nil {
		data["details"] = details
	}
	return data
}

// TruncateOutput truncates a string for safe display (max 2000 chars).
func TruncateOutput(value string) string {
	const max = 2000
	if len(value) <= max {
		return value
	}
	return value[:max] + "...<truncated>"
}

// WorstStatus returns the worst of two status strings.
func WorstStatus(current, next string) string {
	rank := map[string]int{"ok": 0, "warning": 1, "error": 2}
	if rank[next] > rank[current] {
		return next
	}
	return current
}

// SortedClientKeys returns sorted keys of cfg.Clients.
func SortedClientKeys(cfg config.Config) []string {
	keys := make([]string, 0, len(cfg.Clients))
	for k := range cfg.Clients {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// ProviderAuthState is a token-free authentication state for a provider.
// Doctor checks use this to report auth health without exposing credentials.
type ProviderAuthState struct {
	OK         bool   `json:"ok"`
	SourcePath string `json:"source_path,omitempty"`
}

// SortedProfileKeys returns sorted profile names.
func SortedProfileKeys(profiles map[string]Profile) []string {
	keys := make([]string, 0, len(profiles))
	for k := range profiles {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// Dependencies holds all root-package resources the doctor checks need.
// Each field is a callback or precomputed value provided by the root package.
type Dependencies struct {
	// Filesystem helpers
	Exists       func(string) bool
	UserHome     func() string
	ReadFile     func(string) ([]byte, error)
	ReadText     func(string) string
	ExpandHome   func(string) string
	RepoDir      func() (string, error)
	LocalAppData string

	// Config loading
	LoadForgeConfig func() (config.Config, []string, error)
	LoadManifest    func() (ProfileManifest, error)
	ManifestSources func() map[string]string
	UserSecretsPath string
	UserConfigPath  string
	AuthPath        string

	// Auth
	ReadAuth           func() (map[string]interface{}, error)
	AuthPermsOK        func(string) bool
	ResolveCredential  func(string) (string, bool)
	ReadSecretsFile    func(string) map[string]interface{}
	SecretsFilePermsOK func(string) bool

	// Provider
	ProviderSources func() map[string]string
	CatalogRegistry *catalog.Registry

	// Client / profile capabilities
	ClientInstalled             func(string) bool
	ClientKnown                 func(string) bool
	ClientIDs                   func() []string
	IsAliasShortcutClient       func(string) bool
	IsCCShortcutProvider        func(string) bool
	ProviderCredentialAvailable func(Profile) bool

	// Shell
	BuildShellPlan       func(string) (interface{}, error)
	ShellHasConflicts    func(interface{}) bool
	ShellHasActions      func(interface{}) bool
	SafeShellPlanDetails func(interface{}) map[string]interface{}

	// String helpers
	GetStringSlice func(map[string]interface{}, string, []string) []string

	// Codebuddy runtime
	CodebuddyShimPath func() string

	// ProviderAuthStatus returns the authentication state for a provider.
	// This is the SSOT callback from the root package. When set, doctor
	// checks use it instead of direct file reads. It never carries credentials.
	ProviderAuthStatus func(providerID string) ProviderAuthState

	// Grok shell wrapper
	GrokBinaryInstalled func() bool

	// DSHCheck returns the dsh protocol/launcher check map (adapter "dsh")
	// when native dsh is present, or nil when the binary is missing or the
	// root package does not wire it. Presence of native clients belongs to
	// InstallationDoctorCheck; this hook only diagnoses protocol and fdsh.
	DSHCheck func() map[string]interface{}

	// Secrets lookups (for providerCredentialAvailable SecretRef resolution)
	ResolveSecretRef func(*string) (*string, error)
}
