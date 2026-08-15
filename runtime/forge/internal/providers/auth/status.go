package auth

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/grok"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/schema"
)

type CredentialResolverKind = schema.CredentialResolver

const (
	// ResolverForgeManaged reads credentials from Forge auth.json.
	ResolverForgeManaged = schema.CredentialResolverForgeManaged
	// ResolverCodeBuddy reads credentials from CodeBuddy Extension native auth.
	ResolverCodeBuddy = schema.CredentialResolverCodeBuddy
	// ResolverCodex reads credentials from Codex auth.json.
	ResolverCodex = schema.CredentialResolverCodex
	// ResolverClaude reads credentials from Claude .credentials.json.
	ResolverClaude = schema.CredentialResolverClaude
	// ResolverGrokOAuth probes native Grok auth.json without exposing tokens.
	ResolverGrokOAuth = schema.CredentialResolverGrokOAuth
)

// ProviderAuthStatus describes the authentication state for a single provider,
// resolved from the provider's native credential source.
type ProviderAuthStatus struct {
	// ProviderID is the canonical provider identifier.
	ProviderID string `json:"provider_id"`
	// Kind is the credential resolver kind.
	Kind CredentialResolverKind `json:"kind"`
	// Resolver is the resolved credential resolver kind (alias for Kind).
	Resolver CredentialResolverKind `json:"resolver"`
	// OK reports whether the provider has valid credentials.
	OK bool `json:"ok"`
	// Detail is a human-readable status detail.
	Detail string `json:"detail,omitempty"`
	// SourcePath is the path to the credential file, if applicable.
	SourcePath string `json:"source_path,omitempty"`
}

// Credential holds a resolved bearer credential for a provider. The Value
// field contains the raw credential string; Headers fields are additional
// context headers that must be sent alongside the Authorization header.
type Credential struct {
	// Value is the bearer/API-key credential string.
	Value string
	// Headers are additional context headers to include with the request.
	Headers http.Header
}

// ContextHeaders returns the additional context headers for a Credential.
func (c Credential) ContextHeaders() http.Header {
	if c.Headers == nil {
		return make(http.Header)
	}
	return c.Headers.Clone()
}

// ResolverCatalogLookup resolves a provider ID to its CredentialResolverKind.
type ResolverCatalogLookup func(providerID string) (CredentialResolverKind, bool)

// ReadAuthFile is a callback for reading a JSON file.
type ReadAuthFile func(path string) ([]byte, error)

// FileExists is a callback for checking file existence.
type FileExists func(path string) bool

// ProviderAuthStatusResolver resolves the authentication status for a provider.
type ProviderAuthStatusResolver struct {
	// CatalogResolver returns the CredentialResolverKind for a provider ID.
	CatalogResolver ResolverCatalogLookup
	// ForgeDataDir returns the Forge data directory path.
	ForgeDataDir func() string
	// ReadFile reads a file. Defaults to os.ReadFile when nil.
	ReadFile ReadAuthFile
	// FileExists checks file existence. Defaults to fileExists when nil.
	FileExists FileExists
	// UserHome returns the user's home directory.
	UserHome func() string
}

// NewProviderAuthStatusResolver creates a new resolver with default file
// system callbacks.
func NewProviderAuthStatusResolver(
	catalogResolver ResolverCatalogLookup,
	forgeDataDir func() string,
	userHome func() string,
) *ProviderAuthStatusResolver {
	return &ProviderAuthStatusResolver{
		CatalogResolver: catalogResolver,
		ForgeDataDir:    forgeDataDir,
		ReadFile:        os.ReadFile,
		FileExists:      fileExists,
		UserHome:        userHome,
	}
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// ProviderAuthStatus returns the authentication status for the given provider.
func (r *ProviderAuthStatusResolver) ProviderAuthStatus(providerID string) ProviderAuthStatus {
	if r.CatalogResolver == nil {
		return ProviderAuthStatus{
			ProviderID: providerID,
			Detail:     "catalog resolver not configured",
		}
	}
	kind, ok := r.CatalogResolver(providerID)
	if !ok {
		return ProviderAuthStatus{
			ProviderID: providerID,
			Detail:     "unknown provider",
		}
	}

	status := ProviderAuthStatus{
		ProviderID: providerID,
		Kind:       kind,
		Resolver:   kind,
	}

	switch kind {
	case ResolverForgeManaged:
		return r.resolveForgeManaged(status, providerID)
	case ResolverCodeBuddy:
		return r.resolveCodeBuddy(status)
	case ResolverCodex:
		return r.resolveCodex(status)
	case ResolverClaude:
		return r.resolveClaude(status)
	case ResolverGrokOAuth:
		return r.resolveGrokOAuth(status)
	default:
		status.Detail = "unsupported credential resolver"
		return status
	}
}

func (r *ProviderAuthStatusResolver) resolveGrokOAuth(status ProviderAuthStatus) ProviderAuthStatus {
	source, err := grok.SelectOAuthSource(r.ForgeDataDir(), r.UserHome())
	if err != nil {
		status.Detail = err.Error()
		return status
	}
	status.SourcePath = source
	status.OK = true
	status.Detail = "native OAuth available and copyable"
	return status
}

func (r *ProviderAuthStatusResolver) resolveForgeManaged(status ProviderAuthStatus, providerID string) ProviderAuthStatus {
	authPath := Path(r.ForgeDataDir())
	status.SourcePath = authPath
	if !r.FileExists(authPath) {
		status.Detail = "auth.json not found"
		return status
	}
	entries, err := Read(authPath)
	if err != nil {
		status.Detail = fmt.Sprintf("auth.json read error: %v", err)
		return status
	}
	entry, ok := entries[providerID]
	if !ok || entry.Key == "" {
		status.Detail = "no credential for provider"
		return status
	}
	status.OK = true
	status.Detail = "authenticated"
	return status
}

func (r *ProviderAuthStatusResolver) resolveCodeBuddy(status ProviderAuthStatus) ProviderAuthStatus {
	path := codebuddyAuthPath(runtime.GOOS, r.UserHome)
	status.SourcePath = path
	if !r.FileExists(path) {
		status.Detail = "CodeBuddy auth file not found"
		return status
	}
	raw, err := r.ReadFile(path)
	if err != nil {
		status.Detail = fmt.Sprintf("CodeBuddy auth file read error: %v", err)
		return status
	}
	_, ok := parseCodeBuddyAuth(raw)
	if !ok {
		status.Detail = "CodeBuddy auth file missing access token"
		return status
	}
	status.OK = true
	status.Detail = "authenticated"
	return status
}

func (r *ProviderAuthStatusResolver) resolveCodex(status ProviderAuthStatus) ProviderAuthStatus {
	home := r.UserHome()
	codexHome := os.Getenv("CODEX_HOME")
	var authPath string
	if codexHome != "" {
		authPath = filepath.Join(codexHome, "auth.json")
	} else {
		authPath = filepath.Join(home, ".codex", "auth.json")
	}
	status.SourcePath = authPath
	if !r.FileExists(authPath) {
		status.Detail = "Codex auth.json not found"
		return status
	}
	raw, err := r.ReadFile(authPath)
	if err != nil {
		status.Detail = fmt.Sprintf("Codex auth.json read error: %v", err)
		return status
	}
	var data map[string]interface{}
	if err := json.Unmarshal(raw, &data); err != nil {
		status.Detail = "Codex auth.json is not valid JSON"
		return status
	}
	tokens, ok := data["tokens"].(map[string]interface{})
	if !ok {
		status.Detail = "Codex auth.json missing 'tokens' object"
		return status
	}
	accessToken, _ := tokens["access_token"].(string)
	if accessToken == "" {
		// Also support current known shape.
		status.Detail = "Codex auth.json tokens.access_token is empty or missing"
		return status
	}
	status.OK = true
	status.Detail = "authenticated"
	return status
}

func (r *ProviderAuthStatusResolver) resolveClaude(status ProviderAuthStatus) ProviderAuthStatus {
	home := r.UserHome()
	configDir := os.Getenv("CLAUDE_CONFIG_DIR")
	var credsPath string
	if configDir != "" {
		credsPath = filepath.Join(configDir, ".credentials.json")
	} else {
		credsPath = filepath.Join(home, ".claude", ".credentials.json")
	}
	status.SourcePath = credsPath
	if !r.FileExists(credsPath) {
		status.Detail = "Claude .credentials.json not found"
		return status
	}
	raw, err := r.ReadFile(credsPath)
	if err != nil {
		status.Detail = fmt.Sprintf("Claude .credentials.json read error: %v", err)
		return status
	}
	_, ok := parseClaudeAuth(raw)
	if !ok {
		status.Detail = "Claude .credentials.json missing access token"
		return status
	}
	status.OK = true
	status.Detail = "authenticated"
	return status
}

// Credential returns the resolved credential for the provider. It only returns
// the credential value when the provider is authenticated.
func (r *ProviderAuthStatusResolver) Credential(providerID string) (*Credential, bool) {
	status := r.ProviderAuthStatus(providerID)
	if !status.OK {
		return nil, false
	}

	switch status.Kind {
	case ResolverForgeManaged:
		authPath := Path(r.ForgeDataDir())
		entries, err := Read(authPath)
		if err != nil {
			return nil, false
		}
		entry, ok := entries[providerID]
		if !ok || entry.Key == "" {
			return nil, false
		}
		return &Credential{Value: entry.Key}, true

	case ResolverCodeBuddy:
		path := codebuddyAuthPath(runtime.GOOS, r.UserHome)
		raw, err := r.ReadFile(path)
		if err != nil {
			return nil, false
		}
		parsed, ok := parseCodeBuddyAuth(raw)
		if !ok {
			return nil, false
		}
		// CodeBuddy native auth contributes only the bearer token; no
		// company-only context headers are attached.
		return &Credential{Value: parsed.accessToken}, true

	case ResolverCodex:
		home := r.UserHome()
		codexHome := os.Getenv("CODEX_HOME")
		var authPath string
		if codexHome != "" {
			authPath = filepath.Join(codexHome, "auth.json")
		} else {
			authPath = filepath.Join(home, ".codex", "auth.json")
		}
		raw, err := r.ReadFile(authPath)
		if err != nil {
			return nil, false
		}
		var data map[string]interface{}
		if err := json.Unmarshal(raw, &data); err != nil {
			return nil, false
		}
		tokens, ok := data["tokens"].(map[string]interface{})
		if !ok {
			return nil, false
		}
		accessToken, _ := tokens["access_token"].(string)
		if accessToken == "" {
			return nil, false
		}
		return &Credential{Value: accessToken}, true

	case ResolverClaude:
		home := r.UserHome()
		configDir := os.Getenv("CLAUDE_CONFIG_DIR")
		var credsPath string
		if configDir != "" {
			credsPath = filepath.Join(configDir, ".credentials.json")
		} else {
			credsPath = filepath.Join(home, ".claude", ".credentials.json")
		}
		raw, err := r.ReadFile(credsPath)
		if err != nil {
			return nil, false
		}
		parsed, ok := parseClaudeAuth(raw)
		if !ok {
			return nil, false
		}
		return &Credential{Value: parsed.accessToken}, true

	default:
		return nil, false
	}
}

// Headers returns the context headers for the provider, including the
// Authorization header when a credential is available. It never adds
// company-only context headers.
func (r *ProviderAuthStatusResolver) Headers(providerID string) http.Header {
	cred, ok := r.Credential(providerID)
	if !ok {
		return nil
	}
	headers := make(http.Header)
	if cred.Headers != nil {
		for k, v := range cred.Headers {
			headers[k] = v
		}
	}
	if headers.Get("Authorization") == "" {
		headers.Set("Authorization", "Bearer "+cred.Value)
	}
	return headers
}

func codebuddyAuthPath(goos string, userHome func() string) string {
	const authFile = "Tencent-Cloud.coding-copilot.info"
	home := userHome()
	switch goos {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth", authFile)
	case "windows":
		localAppData := os.Getenv("LOCALAPPDATA")
		if localAppData == "" {
			localAppData = filepath.Join(home, "AppData", "Local")
		}
		return filepath.Join(localAppData, "CodeBuddyExtension", "Data", "Public", "auth", authFile)
	default:
		return filepath.Join(home, ".local", "share", "CodeBuddyExtension", "Data", "Public", "auth", authFile)
	}
}

// UnsupportedDirectTransportError is returned when a provider with native-only
// login is used for direct LLM transport without a verified inference endpoint.
type UnsupportedDirectTransportError struct {
	ProviderID string
}

func (e *UnsupportedDirectTransportError) Error() string {
	return fmt.Sprintf("provider %q supports native profile login but does not support direct LLM transport", e.ProviderID)
}

// parsedCodeBuddy holds the parsed fields from the CodeBuddy auth file.
type parsedCodeBuddy struct {
	accessToken string
}

// parseCodeBuddyAuth reads the CodeBuddy auth JSON and extracts the credential
// from the real nested shape (auth.accessToken) with flat-key fallback for
// older fixtures.
func parseCodeBuddyAuth(raw []byte) (*parsedCodeBuddy, bool) {
	var info map[string]interface{}
	if err := json.Unmarshal(raw, &info); err != nil {
		return nil, false
	}

	p := &parsedCodeBuddy{}

	// Try nested auth object.
	if authObj, ok := info["auth"].(map[string]interface{}); ok {
		p.accessToken, _ = authObj["accessToken"].(string)
	}
	// Flat fallback for older fixtures.
	if p.accessToken == "" {
		if v, ok := info["auth.accessToken"].(string); ok {
			p.accessToken = v
		}
	}
	if p.accessToken == "" {
		return nil, false
	}

	return p, true
}

// parsedClaude holds the parsed credential fields from the Claude credentials file.
type parsedClaude struct {
	accessToken string
}

// parseClaudeAuth reads the Claude .credentials.json and extracts the access
// token from the real nested shape (claudeAiOauth.accessToken) with flat-key
// fallback.
func parseClaudeAuth(raw []byte) (*parsedClaude, bool) {
	var info map[string]interface{}
	if err := json.Unmarshal(raw, &info); err != nil {
		return nil, false
	}

	p := &parsedClaude{}

	// Try nested claudeAiOauth object.
	if oauthObj, ok := info["claudeAiOauth"].(map[string]interface{}); ok {
		p.accessToken, _ = oauthObj["accessToken"].(string)
	}
	// Flat literal key fallback.
	if p.accessToken == "" {
		if v, ok := info["claudeAiOauth.accessToken"].(string); ok {
			p.accessToken = v
		}
	}
	// Also try flat accessToken field.
	if p.accessToken == "" {
		if v, ok := info["accessToken"].(string); ok {
			p.accessToken = v
		}
	}

	if p.accessToken == "" {
		return nil, false
	}

	return p, true
}
