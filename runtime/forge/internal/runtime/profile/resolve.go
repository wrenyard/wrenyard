package profile

import "github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"

// RegistryLookuper is the subset of catalog.Registry used by the resolver. It
// is satisfied by *catalog.Registry and keeps the resolver testable with fakes.
type RegistryLookuper interface {
	LookupDescriptor(name string) (catalog.Client, error)
	ResolveBinding(clientName, providerName string) (catalog.Client, catalog.Provider, error)
}

// Callbacks bundles the injected root-side dependencies so the profile package
// performs no filesystem I/O and imports nothing outside catalog.
type Callbacks struct {
	Credential CredentialCallbacks
}

// Resolve resolves an already-loaded and already-dispatch-gated profile
// snapshot against the current DefaultRegistry (or an equivalent lookuper).
// When the current catalog supports the client and its provider/binding, it
// returns CompatibilityNone with the resolved Client and Provider. Otherwise
// it returns the same usable snapshot with an explicit compatibility mode and
// reason, and no leaked catalog error.
//
// Resolution preserves the current legacy fallback behavior:
//   - missing client -> CompatibilityClientUnregistered
//   - missing provider/binding -> CompatibilityProviderUnregistered
//   - dialect incompatibility -> CompatibilityDialectIncompatible
//
// Resolve does NOT validate the model, resolve binaries, create directories,
// plan command/env/stdin, or perform any CLI/config/auth file I/O. It resolves
// the CredentialPlan at the credential stage through the injected callbacks.
// The catalog default provider is never used to trigger credential lookup;
// only the raw explicit Provider does.
func Resolve(input InputProfile, reg RegistryLookuper, cb Callbacks) (ResolvedProfile, error) {
	out := ResolvedProfile{
		Name:     input.Name,
		Launcher: launcherFromInput(input.Launcher),
		Env:      cloneEnv(input.Env),
		Settings: cloneSettings(input.Settings),
	}

	_, descErr := reg.LookupDescriptor(input.Client)
	if descErr != nil {
		out.Compatibility = CompatibilityClientUnregistered
		// Fall back to credential planning using the raw explicit provider so
		// current credential behavior is preserved for compatibility profiles.
		plan, err := PlanCredential(input, cb.Credential)
		if err != nil {
			return out, err
		}
		out.Credential = plan
		return out, nil
	}

	client, binding, bindErr := reg.ResolveBinding(input.Client, input.Provider)
	if bindErr != nil {
		// Classify the binding failure without leaking the catalog error text.
		if isUnknownProvider(bindErr) {
			out.Compatibility = CompatibilityProviderUnregistered
		} else {
			out.Compatibility = CompatibilityDialectIncompatible
		}
		plan, err := PlanCredential(input, cb.Credential)
		if err != nil {
			return out, err
		}
		out.Credential = plan
		return out, nil
	}

	// Clean catalog hit.
	out.Client = client
	out.Provider = binding
	out.Compatibility = CompatibilityNone

	plan, err := PlanCredential(input, cb.Credential)
	if err != nil {
		return out, err
	}
	out.Credential = plan
	return out, nil
}

// isUnknownProvider reports whether the binding error is an unknown-provider
// failure rather than a dialect-incompatibility failure. It inspects the error
// text written by catalog.Registry so the resolver does not new-type errors.
// The dialect-incompatible error always contains "not compatible with dialect";
// when absent, an unknown provider binding error is assumed.
func isUnknownProvider(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	if contains(msg, "not compatible with dialect") {
		return false
	}
	return contains(msg, "provider binding") || contains(msg, "unknown provider")
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
