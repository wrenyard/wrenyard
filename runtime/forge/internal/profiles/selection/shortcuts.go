package selection

import "strings"

var aliasShortcutClients = map[string]bool{
	"claude": true,
}

var ccShortcutProviders = map[string]bool{
	"zhipu-coding": true,
	"kimi-coding":  true,
}

// ClientEmitsAliasShortcut reports whether a client is known to emit shell
// alias shortcuts.
func ClientEmitsAliasShortcut(client string) bool {
	return aliasShortcutClients[client]
}

// ProviderSupportsCCShortcut reports whether a provider's profiles should
// render rich Claude Code shortcut wrappers.
func ProviderSupportsCCShortcut(provider string) bool {
	return ccShortcutProviders[provider]
}

// ShortcutUsesRichCC reports whether a profile uses a rich Claude Code
// shortcut (i.e. its provider supports CC shortcuts).
func ShortcutUsesRichCC(p Profile) bool {
	return ProviderSupportsCCShortcut(p.Provider)
}

// ProviderCredentialAvailable checks whether a provider credential is
// available for a profile. Rich-CC providers require an explicit credential;
// codex and codebuddy native providers are checked via the auth SSOT.
func ProviderCredentialAvailable(p Profile, deps Dependencies) bool {
	if !ProviderSupportsCCShortcut(p.Provider) {
		// For non-rich-CC providers (codex, codebuddy native), delegate to
		// credential resolution rather than assuming always available.
		if p.SecretRef != nil {
			resolved, err := deps.ResolveSecret(p.SecretRef)
			return err == nil && resolved != nil && strings.TrimSpace(*resolved) != ""
		}
		cred, ok := deps.ResolveCredential(p.Provider)
		return ok && strings.TrimSpace(cred) != ""
	}
	if p.SecretRef != nil {
		resolved, err := deps.ResolveSecret(p.SecretRef)
		return err == nil && resolved != nil && strings.TrimSpace(*resolved) != ""
	}
	cred, ok := deps.ResolveCredential(p.Provider)
	return ok && strings.TrimSpace(cred) != ""
}
