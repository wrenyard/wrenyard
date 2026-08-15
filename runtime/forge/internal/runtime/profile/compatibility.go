package profile

// CompatibilityMode records whether a profile resolved cleanly through the
// current catalog or fell back to a legacy/compatibility construction path.
// It is internal-only and must never enter CLI output, protocol.Result, or
// Stream v1.
type CompatibilityMode string

const (
	// CompatibilityNone means the profile resolved cleanly through the current
	// catalog and dialect compatibility rules.
	CompatibilityNone CompatibilityMode = "none"
	// CompatibilityClientUnregistered means the client was not found in the
	// current catalog; the profile must use legacy construction.
	CompatibilityClientUnregistered CompatibilityMode = "client_unregistered"
	// CompatibilityProviderUnregistered means the client was registered but its
	// provider/binding was not found in the current catalog.
	CompatibilityProviderUnregistered CompatibilityMode = "provider_unregistered"
	// CompatibilityDialectIncompatible means the binding exists but is not
	// compatible with the client dialect.
	CompatibilityDialectIncompatible CompatibilityMode = "dialect_incompatible"
)

// CompatibilityReason is a diagnostic/test-only string explaining why a
// non-CompatibilityNone mode was selected. It must never leave the resolver:
// do not format it into CLI output, protocol.Result, or Stream v1.
type CompatibilityReason string

const (
	ReasonNone                 CompatibilityReason = ""
	ReasonClientUnregistered   CompatibilityReason = "client not registered in current catalog"
	ReasonProviderUnregistered CompatibilityReason = "provider/binding not registered in current catalog"
	ReasonDialectIncompatible  CompatibilityReason = "provider binding incompatible with client dialect"
)
