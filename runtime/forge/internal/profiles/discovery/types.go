package discovery

// ProfileRef is a neutral DTO describing a profile for discovery/presentation.
// It carries only the fields needed by the profiles command; no root types.
type ProfileRef struct {
	Name        string
	Client      string
	Provider    string
	SecretRef   *string
	Launcher    map[string]interface{}
	Env         map[string]string
	Settings    map[string]interface{}
	Description string
	Supports1M  bool
	Deprecated  bool
	Reason      string
}

// ProviderRef is a neutral DTO describing a configured provider for presentation.
type ProviderRef struct {
	ID      string
	APIKind string
	Source  string
}

// EffectiveProfile represents a profile that is currently available and
// dispatchable for discovery listing.
type EffectiveProfile struct {
	ID          string
	DisplayName string
}

// PolicyProfileCandidate carries candidate profile id and the effective
// resolution info for a policy profile view.
type PolicyProfileCandidate struct {
	ProfileID string
	Effective bool
	Reason    string
}

// PolicyProfileInfo holds the ordered candidates and effective resolution
// information for a profile policy.
type PolicyProfileInfo struct {
	PolicyID   string
	Candidates []PolicyProfileCandidate
}

// ModelDisplayInfo carries canonical model display metadata for a provider.
type ModelDisplayInfo struct {
	ProviderID string
	Models     []string
}

// AuthOperation describes a login or logout operation for a provider.
type AuthOperation int

const (
	AuthLogin  AuthOperation = iota
	AuthLogout AuthOperation = iota
)

// ProviderAuthDeps bundles callbacks for provider auth operations used
// by the providers command.
type ProviderAuthDeps struct {
	ProviderLogin     func(providerID string) error
	ProviderLogout    func(providerID string) error
	ResolveCredential func(providerID string) (string, bool)
}
