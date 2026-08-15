package profile

import "fmt"

// CredentialPlan describes the resolved credential injection for a profile.
// It must be applied by the caller at the exact credential-resolution stage,
// preserving the legacy env-overlay order. The resolved secret Value is
// sensitive: it is excluded from JSON and must never be formatted into errors
// or logs.
type CredentialPlan struct {
	// TargetEnv is the environment variable that receives the credential value
	// (e.g. ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY).
	TargetEnv string `json:"target_env"`
	// Value is the resolved secret. It is intentionally excluded from JSON and
	// must not be formatted into errors or logs.
	Value string `json:"-"`
	// Source describes how the value was resolved (secret_ref literal, profile
	// literal, managed/unmanaged provider lookup, or none). It is diagnostic
	// only and must not leak the secret.
	Source string `json:"source"`
}

// Credential stage callbacks. The root forge package wires these to its
// existing resolveSecret, ResolveCredential, and IsManagedProvider so that all
// auth.json / user / repo secret file I/O remains in the root package. The
// profile package never performs filesystem I/O.
type CredentialCallbacks struct {
	// ResolveSecret resolves a secret_ref string (or nil) and returns the
	// concrete secret value, a flag indicating a profile: literal was
	// supplied, or an error. Returns (value, isProfileLiteral, err).
	ResolveSecret func(ref *string) (value *string, isProfileLiteral bool, err error)
	// ResolveProviderCredential resolves a credential for a provider id via the
	// auth chain (auth.json, then user/repo secrets). Returns ("", false) when
	// no credential is found.
	ResolveProviderCredential func(providerID string) (value string, ok bool)
	// IsManagedProvider reports whether the provider is Forge-managed and thus
	// requires a credential fail-closed.
	IsManagedProvider func(providerID string) bool
}

// kimiCoding is the provider whose credential targets ANTHROPIC_API_KEY; all
// other providers target ANTHROPIC_AUTH_TOKEN to preserve current behavior.
const kimiCoding = "kimi-coding"

// CredentialTargetEnv returns the env var that receives the credential for the
// given provider, preserving the current kimi-coding vs non-kimi distinction.
func CredentialTargetEnv(provider string) string {
	if provider == kimiCoding {
		return "ANTHROPIC_API_KEY"
	}
	return "ANTHROPIC_AUTH_TOKEN"
}

// PlanCredential computes the CredentialPlan from the raw explicit provider and
// secret_ref, preserving the current resolution order exactly:
//
//  1. explicit secret_ref resolution wins (via ResolveSecret):
//     resolved value injected; "profile:" literal injected as-is; "system:"
//     no injection; other kinds resolved to a value or error.
//  2. without secret_ref, only the raw explicit Provider triggers a provider
//     credential lookup. The catalog default provider must NOT trigger
//     credentials.
//     - missing Forge-managed provider credential fails with the exact text
//     `no credential for provider %q; run forge auth login %s`.
//     - unmanaged missing credential is allowed (no injection).
func PlanCredential(input InputProfile, cb CredentialCallbacks) (CredentialPlan, error) {
	targetEnv := CredentialTargetEnv(input.Provider)
	plan := CredentialPlan{TargetEnv: targetEnv}

	if input.SecretRef != nil {
		value, isProfileLiteral, err := cb.ResolveSecret(input.SecretRef)
		if err != nil {
			return plan, err
		}
		if value != nil {
			plan.Value = *value
			plan.Source = "secret_ref"
		} else if isProfileLiteral {
			// profile: literal is injected verbatim into TargetEnv.
			plan.Value = *input.SecretRef
			plan.Source = "secret_ref_profile_literal"
		}
		// system: and other nil-but-no-error results mean no injection.
		return plan, nil
	}

	if input.Provider != "" {
		value, ok := cb.ResolveProviderCredential(input.Provider)
		if !ok || value == "" {
			if cb.IsManagedProvider(input.Provider) {
				return plan, &noCredentialError{provider: input.Provider}
			}
			// Unmanaged provider missing credential is allowed.
			return plan, nil
		}
		plan.Value = value
		plan.Source = "provider"
	}

	return plan, nil
}

// noCredentialError preserves the exact fail-closed error text for a missing
// Forge-managed provider credential.
type noCredentialError struct {
	provider string
}

func (e *noCredentialError) Error() string {
	return fmt.Sprintf("no credential for provider %q; run forge auth login %s", e.provider, e.provider)
}
