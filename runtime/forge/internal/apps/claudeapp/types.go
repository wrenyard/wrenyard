package claudeapp

import "runtime"

const (
	defaultPort       = 18080
	registryKey       = `HKCU\SOFTWARE\Policies\Claude`
	stateFileName     = "claude-app.json"
	gatewayAuthScheme = "bearer"
	configLibraryID   = "00000000-0000-4000-8000-000000180080"

	opusID   = "claude-opus-4-8"
	sonnetID = "claude-sonnet-4-6"
	haikuID  = "claude-haiku-4-5"
)

var slotDefs = [...]struct {
	slot     string
	modelID  string
	modelEnv string
	nameEnv  string
}{
	{"opus", opusID, "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME"},
	{"sonnet", sonnetID, "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME"},
	{"haiku", haikuID, "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME"},
}

var managedPolicyNames = []string{
	"inferenceProvider",
	"inferenceGatewayBaseUrl",
	"inferenceGatewayApiKey",
	"inferenceGatewayAuthScheme",
	"inferenceGatewayHeaders",
	"inferenceModels",
	"isClaudeCodeForDesktopEnabled",
	"coworkEgressAllowedHosts",
	"forge_managed",
}

// Profile is the minimal subset of a Forge profile needed by the Claude app
// gateway. It is a value type owned by the claudeapp package so the package has
// no dependency on the root forge package.
type Profile struct {
	Name       string                 `json:"name,omitempty"`
	Client     string                 `json:"client"`
	Provider   string                 `json:"provider"`
	SecretRef  *string                `json:"secret_ref"`
	Env        map[string]string      `json:"env"`
	Settings   map[string]interface{} `json:"settings"`
	Supports1M bool                   `json:"supports_1m,omitempty"`
	Reason     string                 `json:"reason,omitempty"`
	Deprecated bool                   `json:"deprecated,omitempty"`
}

// State is the on-disk Claude app gateway state.
type State struct {
	GatewayAPIKey  string `json:"gateway_api_key"`
	Profile        string `json:"profile,omitempty"`
	Provider       string `json:"provider,omitempty"`
	Port           int    `json:"port,omitempty"`
	GatewayBaseURL string `json:"gateway_base_url,omitempty"`
	UpdatedAt      string `json:"updated_at,omitempty"`
}

// ModelRoute describes one exposed Claude app model slot.
type ModelRoute struct {
	Name          string `json:"name"`
	DisplayName   string `json:"displayName,omitempty"`
	LabelOverride string `json:"labelOverride,omitempty"`
	Slot          string `json:"-"`
	UpstreamModel string `json:"-"`
	Supports1M    bool   `json:"supports1m,omitempty"`
}

// Config is the resolved configuration for the Claude app gateway, derived from
// a Forge profile by the root package.
type Config struct {
	Profile         Profile
	Port            int
	GatewayBaseURL  string
	GatewayAPIKey   string
	UpstreamBaseURL string
	UpstreamToken   string
	Routes          []ModelRoute
}

// ProviderBinding carries the resolved inference protocol and endpoint
// for a profile's provider, keeping claudeapp decoupled from the catalog
// package.
type ProviderBinding struct {
	Protocol     string
	Endpoint     string
	DefaultModel string
}

// Dependencies groups the external capabilities (file system, shell, runtime
// helpers, secret/credential/launch resolution) the claudeapp package needs so
// it remains decoupled from the root forge package. The root package populates
// these when wiring the command flow.
type Dependencies struct {
	LoadManifest           func() (map[string]Profile, error)
	ResolveCredential      func(providerID string) (string, bool)
	UserHome               func() string
	RepoDir                func() (string, error)
	CurrentForgePath       func() (string, error)
	ModelOverrides         func(p Profile) map[string]string
	ModelDisplayName       func(providerID, modelID string) string
	ResolveProviderBinding func(p Profile) (ProviderBinding, error)
	DefaultPort            int
}

// apiError is a small sentinel-free error type used internally.
func isWindows() bool { return runtime.GOOS == "windows" }
