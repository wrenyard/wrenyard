package selection

// ProfileCredentialAvailable checks whether a profile's provider has a
// resolvable credential. It delegates to ProviderCredentialAvailable for all
// providers, including native-login providers.
func ProfileCredentialAvailable(p Profile, deps Dependencies) bool {
	if p.Provider == "" {
		return true
	}
	return ProviderCredentialAvailable(p, deps)
}
