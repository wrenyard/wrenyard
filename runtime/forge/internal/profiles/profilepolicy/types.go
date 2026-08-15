// Package profilepolicy owns the source-owned policy types, registry,
// and resolver. It does not import the root forge package.
package profilepolicy

// AvailabilityReason codes returned when a candidate is unavailable.
const (
	ReasonDefinitionInvalid      = "definition_invalid"
	ReasonClientMissing          = "client_missing"
	ReasonClientUnsupported      = "client_unsupported"
	ReasonProviderBindingInvalid = "provider_binding_invalid"
	ReasonProviderAuthMissing    = "provider_auth_missing"
	ReasonProfileDisabled        = "profile_disabled"
)

// Candidate is a single profile candidate within a policy.
// Threshold is a percentage (0-100); 0 means use the default.
type Candidate struct {
	ProfileID string `json:"profile"`
	Threshold int    `json:"threshold,omitempty"`
}

// ProfilePolicy defines a named policy with an ordered candidate list.
type ProfilePolicy struct {
	Name       string      `json:"name"`
	Candidates []Candidate `json:"candidates"`
}

// ResolveRequest carries the input needed to resolve a policy.
type ResolveRequest struct {
	Policy ProfilePolicy
}

// Resolution is the outcome of policy resolution.
type Resolution struct {
	ProfileID    string             `json:"profile"`
	PolicyName   string             `json:"policy"`
	CandidateIDs []string           `json:"candidates,omitempty"`
	OK           bool               `json:"ok"`
	Failures     []CandidateFailure `json:"failures,omitempty"`
	Suggestions  []string           `json:"suggestions,omitempty"`
}

// CandidateFailure records why a candidate was not selected.
type CandidateFailure struct {
	ProfileID string `json:"profile"`
	Reason    string `json:"reason"`
}

// Dependencies carries the callbacks needed by the resolver.
type Dependencies struct {
	// IsProfileEffective reports whether a profile ID is fully available
	// (client installed, provider binding valid, credential present).
	IsProfileEffective func(profileID string) bool
	// CanonicalPoolUsagePct returns the current usage percentage (0-100)
	// for a canonical quota pool, or -1 if the pool is unknown.
	CanonicalPoolUsagePct func(canonicalPool string) int
	// CanonicalPoolForProfile derives the quota pool from the resolved profile's
	// provider module. Empty means the profile has no quota gate.
	CanonicalPoolForProfile func(profileID string) string
}
