package auth

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/grok"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/cursor"
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
	// ResolverCursor reads credentials from Cursor Desktop's state.vscdb.
	ResolverCursor = schema.CredentialResolverCursor
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
	// CodeBuddyProductPath optionally points directly at the installed
	// CodeBuddy product.json used to classify the auth environment. When
	// empty, the resolver uses ACC_PRODUCT_CONFIG_PATH and the resolved
	// codebuddy executable/product.json candidates.
	CodeBuddyProductPath string
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
	case ResolverCursor:
		return r.resolveCursor(status)
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

// resolveCursor recognizes Cursor Desktop login by checking that a readable
// state.vscdb exists and holds an access token. The status only ever reports
// availability and the database path; it never carries the token.
func (r *ProviderAuthStatusResolver) resolveCursor(status ProviderAuthStatus) ProviderAuthStatus {
	statePath := cursor.StatePath(r.UserHome())
	status.SourcePath = statePath
	if !r.FileExists(statePath) {
		status.Detail = "Cursor state.vscdb not found"
		return status
	}
	token, err := cursor.AccessToken(statePath)
	if err != nil {
		status.Detail = "Cursor state.vscdb access token unavailable"
		return status
	}
	if strings.TrimSpace(token) == "" {
		status.Detail = "Cursor state.vscdb missing access token"
		return status
	}
	status.OK = true
	status.Detail = "authenticated"
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

	case ResolverCursor:
		statePath := cursor.StatePath(r.UserHome())
		token, err := cursor.AccessToken(statePath)
		if err != nil || strings.TrimSpace(token) == "" {
			return nil, false
		}
		return &Credential{Value: token}, true

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

// CodeBuddyActiveScope is the privacy-safe result of resolving the active
// CodeBuddy login: a normalized observed environment and an opaque cbv1:
// SHA-256 scope digest. It never carries tokens, names, avatars, expiry, or
// raw account/domain text.
type CodeBuddyActiveScope struct {
	// OK reports whether a stable account id, an access token, and a
	// recognized environment were all resolved from the native auth file.
	OK bool `json:"ok"`
	// Environment is the normalized observed environment (internal, ioa,
	// cloudhosted, or external). It is empty when OK is false.
	Environment string `json:"environment,omitempty"`
	// Scope is the opaque cbv1: execution/quota scope. It is empty when OK is
	// false.
	Scope string `json:"scope,omitempty"`
}

// codeBuddyEnvironmentAttributeKeys maps the product.json
// authentication.attributes keys to their normalized environment label,
// mirroring packages/providers/src/runtime.ts classification order.
var codeBuddyEnvironmentAttributeKeys = []struct {
	key   string
	label string
}{
	{"internalDomain", "internal"},
	{"iOADomain", "ioa"},
	{"cloudHostedDomain", "cloudhosted"},
	{"externalDomain", "external"},
}

// codeBuddyStableIDFieldOrder mirrors the TypeScript stable account id
// precedence: uid, then uin, then oneidAccountId.
var codeBuddyStableIDFieldOrder = []string{"uid", "uin", "oneidAccountId"}

// codeBuddyStableIdentityFields are the optional supporting identity fields,
// resolved with the same per-field precedence chain as the account id.
var codeBuddyStableIdentityFields = []string{"enterpriseId", "accountType", "idp"}

// CodeBuddyActiveScope derives the opaque scope and observed environment for
// the active CodeBuddy native login. It reads the native auth file exactly
// once and independently classifies the environment from the current auth
// domain. It fails closed (ok=false) whenever the access token, a stable
// non-secret account id, the product attributes, or a recognized environment
// is unavailable. Existing Credential and ProviderAuthStatus behavior is
// untouched.
func (r *ProviderAuthStatusResolver) CodeBuddyActiveScope() CodeBuddyActiveScope {
	var none CodeBuddyActiveScope

	path := codebuddyAuthPath(runtime.GOOS, r.UserHome)
	raw, err := r.ReadFile(path)
	if err != nil {
		return none
	}
	state, ok := parseCodeBuddyActiveState(raw)
	if !ok {
		return none
	}
	accountID, enterpriseID, accountType, idp := codeBuddyStableAccountIdentity(state)
	if accountID == "" {
		return none
	}
	attributes := r.loadCodeBuddyAuthenticationAttributes()
	environment := classifyCodeBuddyEnvironment(attributes, state.domain)
	if environment == "" || environment == "unknown" {
		return none
	}
	scope, ok := codeBuddyScopeDigest(&codebuddyActive{
		accessToken:  state.accessToken,
		accountID:    accountID,
		domain:       state.domain,
		enterpriseID: enterpriseID,
		accountType:  accountType,
		idp:          idp,
	}, environment)
	if !ok {
		return none
	}
	return CodeBuddyActiveScope{OK: true, Environment: environment, Scope: scope}
}

// codebuddyActive is the parsed, privacy-safe subset of the CodeBuddy native
// auth file needed to derive an opaque scope and observed environment. Tokens
// are only required (never hashed or returned); names, avatars, sessions, and
// expiry are never captured.
type codebuddyActive struct {
	accessToken  string
	accountID    string
	domain       string
	enterpriseID string
	accountType  string
	idp          string
}

// codebuddyAuthState is the normalized view of one CodeBuddy auth file used by
// the active-scope derivation, mirroring packages/providers/src/runtime.ts.
type codebuddyAuthState struct {
	accessToken string
	domain      string
	authObject  map[string]interface{}
	root        map[string]interface{}
}

// parseCodeBuddyActiveState reads one CodeBuddy auth file. The access token
// and domain are read from the nested "auth" object first, then from the flat
// "auth.*" root keys only; top-level token/domain keys are not part of the
// TypeScript contract.
func parseCodeBuddyActiveState(raw []byte) (*codebuddyAuthState, bool) {
	var root map[string]interface{}
	if err := json.Unmarshal(raw, &root); err != nil {
		return nil, false
	}
	var authObject map[string]interface{}
	if obj, ok := root["auth"].(map[string]interface{}); ok {
		authObject = obj
	}
	accessToken := nonEmptyString(authObject["accessToken"])
	if accessToken == "" {
		accessToken = nonEmptyString(root["auth.accessToken"])
	}
	if accessToken == "" {
		return nil, false
	}
	domain := nonEmptyString(authObject["domain"])
	if domain == "" {
		domain = nonEmptyString(root["auth.domain"])
	}
	return &codebuddyAuthState{
		accessToken: accessToken,
		domain:      domain,
		authObject:  authObject,
		root:        root,
	}, true
}

func nonEmptyString(value interface{}) string {
	if s, ok := value.(string); ok && strings.TrimSpace(s) != "" {
		return strings.TrimSpace(s)
	}
	return ""
}

// codeBuddyStableFieldValue accepts a string or a finite JSON number for a
// stable identity field. Strings are trimmed; finite numbers are normalized
// with the ECMAScript String(number) decimal form. Every other value is
// rejected.
func codeBuddyStableFieldValue(value interface{}) (string, bool) {
	switch v := value.(type) {
	case string:
		s := strings.TrimSpace(v)
		if s == "" {
			return "", false
		}
		return s, true
	case float64:
		return codeBuddyJSNumberString(v)
	}
	return "", false
}

// codeBuddyJSNumberString renders a finite JSON number exactly like
// JavaScript's String(number) so numeric identity fields produce byte-identical
// scope digests on both sides of the port.
func codeBuddyJSNumberString(value float64) (string, bool) {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return "", false
	}
	if value == 0 {
		return "0", true
	}
	sign := ""
	if math.Signbit(value) {
		sign = "-"
		value = -value
	}
	// Shortest round-trip mantissa digits and decimal exponent.
	form := strconv.FormatFloat(value, 'e', -1, 64)
	mantissa, exponentText, ok := strings.Cut(form, "e")
	if !ok {
		return "", false
	}
	digits := strings.ReplaceAll(mantissa, ".", "")
	exponent, err := strconv.Atoi(exponentText)
	if err != nil {
		return "", false
	}
	// n is the number of integer digits of the shortest representation.
	// ECMAScript uses decimal notation while -6 < n <= 21 and switches to
	// exponent notation otherwise.
	n := exponent + 1
	k := len(digits)
	switch {
	case k <= n && n <= 21:
		return sign + digits + strings.Repeat("0", n-k), true
	case 0 < n && n <= 21:
		return sign + digits[:n] + "." + digits[n:], true
	case n <= 0 && n > -6:
		return sign + "0." + strings.Repeat("0", -n) + digits, true
	}
	return sign + codeBuddyJSExponent(digits, exponent), true
}

// codeBuddyJSExponent renders the ECMAScript exponent notation e<sign><digits>.
func codeBuddyJSExponent(digits string, exponent int) string {
	head := digits[:1]
	if rest := digits[1:]; rest != "" {
		head += "." + rest
	}
	sign := "+"
	if exponent < 0 {
		sign = "-"
		exponent = -exponent
	}
	return head + "e" + sign + strconv.Itoa(exponent)
}

// codeBuddyStableField resolves one identity field with the TypeScript
// precedence chain: the top-level "account" object, then the nested
// "auth.account" object, then direct fields on the nested "auth" object, then
// flat "auth.<field>" root keys.
func codeBuddyStableField(key string, state *codebuddyAuthState) (string, bool) {
	if account, ok := state.root["account"].(map[string]interface{}); ok {
		if value, ok := codeBuddyStableFieldValue(account[key]); ok {
			return value, true
		}
	}
	if state.authObject != nil {
		if account, ok := state.authObject["account"].(map[string]interface{}); ok {
			if value, ok := codeBuddyStableFieldValue(account[key]); ok {
				return value, true
			}
		}
		if value, ok := codeBuddyStableFieldValue(state.authObject[key]); ok {
			return value, true
		}
	}
	return codeBuddyStableFieldValue(state.root["auth."+key])
}

// codeBuddyStableAccountIdentity resolves the stable non-secret account id with
// uid, then uin, then oneidAccountId precedence and reads the optional
// supporting identity fields through the same per-field lookup chain.
func codeBuddyStableAccountIdentity(state *codebuddyAuthState) (accountID, enterpriseID, accountType, idp string) {
	for _, field := range codeBuddyStableIDFieldOrder {
		if value, ok := codeBuddyStableField(field, state); ok {
			accountID = value
			break
		}
	}
	if accountID == "" {
		return "", "", "", ""
	}
	for _, field := range codeBuddyStableIdentityFields {
		value, ok := codeBuddyStableField(field, state)
		if !ok {
			continue
		}
		switch field {
		case "enterpriseId":
			enterpriseID = value
		case "accountType":
			accountType = value
		case "idp":
			idp = value
		}
	}
	return accountID, enterpriseID, accountType, idp
}

// classifyCodeBuddyEnvironment matches the auth domain against the decoded
// product.json authentication.attributes in internal/ioa/cloudhosted/external
// priority, exactly like packages/providers/src/runtime.ts. An empty result
// means the attributes could not be read; "unknown" means no attribute
// matched.
func classifyCodeBuddyEnvironment(attributes map[string]json.RawMessage, domain string) string {
	if len(attributes) == 0 || domain == "" {
		return "unknown"
	}
	for _, attribute := range codeBuddyEnvironmentAttributeKeys {
		raw, ok := attributes[attribute.key]
		if !ok {
			continue
		}
		for _, pattern := range codeBuddyDomainPatterns(raw) {
			if codeBuddyDomainMatches(pattern, domain) {
				return attribute.label
			}
		}
	}
	return "unknown"
}

// codeBuddyDomainPatterns decodes one authentication.attributes value, which
// may be a single domain string or an array of domain strings. Non-string
// entries are ignored.
func codeBuddyDomainPatterns(raw json.RawMessage) []string {
	var value interface{}
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	switch v := value.(type) {
	case string:
		return []string{v}
	case []interface{}:
		var patterns []string
		for _, item := range v {
			if s, ok := item.(string); ok {
				patterns = append(patterns, s)
			}
		}
		return patterns
	}
	return nil
}

// codeBuddyDomainMatches mirrors the TypeScript matcher transformation:
// exact strings match exactly; otherwise dots are escaped and '*' becomes a
// one-label wildcard ([^.]*). Other regexp metacharacters retain the same
// meaning they have in the TypeScript RegExp constructor. Matching is
// case-sensitive.
func codeBuddyDomainMatches(pattern, domain string) bool {
	if pattern == domain {
		return true
	}
	if !strings.Contains(pattern, "*") {
		return false
	}
	expression := strings.ReplaceAll(pattern, ".", `\.`)
	expression = strings.ReplaceAll(expression, "*", "[^.]*")
	re, err := regexp.Compile("^" + expression + "$")
	if err != nil {
		return false
	}
	return re.MatchString(domain)
}

// loadCodeBuddyAuthenticationAttributes locates and decodes the CodeBuddy
// product.json authentication.attributes exactly like the TypeScript runtime:
// the explicit CodeBuddyProductPath, ACC_PRODUCT_CONFIG_PATH, then each PATH
// directory's codebuddy executable candidate (codebuddy.cmd on Windows). JSON
// candidates are read directly; executable candidates are realpathed and
// product.json is resolved one directory above them. No user-config guesses
// are added. These product reads are separate from the single auth-file read
// of the invocation.
func (r *ProviderAuthStatusResolver) loadCodeBuddyAuthenticationAttributes() map[string]json.RawMessage {
	var candidates []string
	seen := make(map[string]bool)
	addCandidate := func(candidate string) {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" || seen[candidate] {
			return
		}
		seen[candidate] = true
		candidates = append(candidates, candidate)
	}
	addCandidate(r.CodeBuddyProductPath)
	addCandidate(os.Getenv("ACC_PRODUCT_CONFIG_PATH"))
	delimiter := ":"
	executable := "codebuddy"
	if runtime.GOOS == "windows" {
		delimiter = ";"
		executable = "codebuddy.cmd"
	}
	for _, directory := range strings.Split(os.Getenv("PATH"), delimiter) {
		directory = strings.TrimSpace(directory)
		if directory == "" {
			continue
		}
		if runtime.GOOS == "windows" {
			addCandidate(filepath.Join(directory, "node_modules", "@tencent-ai", "codebuddy-code", "product.json"))
		}
		addCandidate(filepath.Join(directory, executable))
	}
	for _, candidate := range candidates {
		var productPath string
		if strings.HasSuffix(candidate, ".json") {
			productPath = candidate
		} else {
			resolved, err := filepath.EvalSymlinks(candidate)
			if err != nil {
				continue
			}
			productPath = filepath.Join(filepath.Dir(resolved), "..", "product.json")
		}
		if attributes, ok := readCodeBuddyProductAttributes(productPath); ok {
			return attributes
		}
	}
	return nil
}

func readCodeBuddyProductAttributes(productPath string) (map[string]json.RawMessage, bool) {
	data, err := os.ReadFile(productPath)
	if err != nil {
		return nil, false
	}
	var product struct {
		Authentication struct {
			Attributes json.RawMessage `json:"attributes"`
		} `json:"authentication"`
	}
	if err := json.Unmarshal(data, &product); err != nil || len(product.Authentication.Attributes) == 0 {
		return nil, false
	}
	var attributes map[string]json.RawMessage
	if err := json.Unmarshal(product.Authentication.Attributes, &attributes); err != nil || attributes == nil {
		return nil, false
	}
	return attributes, true
}

// codeBuddyScopeDigest computes the opaque cbv1: scope for the active login.
// The canonical TS payload has keys inserted in the exact order id,
// enterpriseId?, accountType?, idp?, domain?, environment and is hashed as the
// UTF-8 string "cbv1:" + payload with SHA-256. Tokens, refresh tokens,
// sessions, names, avatars, and expiry are never part of the payload.
func codeBuddyScopeDigest(active *codebuddyActive, environment string) (string, bool) {
	payload := struct {
		ID           string `json:"id"`
		EnterpriseID string `json:"enterpriseId,omitempty"`
		AccountType  string `json:"accountType,omitempty"`
		IDP          string `json:"idp,omitempty"`
		Domain       string `json:"domain,omitempty"`
		Environment  string `json:"environment"`
	}{
		ID:           active.accountID,
		EnterpriseID: active.enterpriseID,
		AccountType:  active.accountType,
		IDP:          active.idp,
		Domain:       active.domain,
		Environment:  environment,
	}
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(payload); err != nil {
		return "", false
	}
	canonical := strings.TrimSuffix(buf.String(), "\n")
	// encoding/json always escapes the two JavaScript line-separator runes,
	// while modern JSON.stringify emits them as UTF-8. Undo only those two
	// extra escapes so the digest input is byte-identical across runtimes.
	canonical = strings.ReplaceAll(canonical, `\u2028`, "\u2028")
	canonical = strings.ReplaceAll(canonical, `\u2029`, "\u2029")
	sum := sha256.Sum256([]byte("cbv1:" + canonical))
	return "cbv1:" + hex.EncodeToString(sum[:]), true
}
