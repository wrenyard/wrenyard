package profile

import (
	"fmt"
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

// fakeRegistry is a minimal RegistryLookuper for tests.
type fakeRegistry struct {
	clients   map[string]catalog.Client
	providers map[string]catalog.Provider
}

func newFakeRegistry() *fakeRegistry {
	return &fakeRegistry{
		clients: map[string]catalog.Client{
			"claude":    {Name: "claude", Dialect: catalog.DialectClaudeCode, DefaultProvider: "anthropic-sub"},
			"codebuddy": {Name: "codebuddy", Dialect: catalog.DialectClaudeCode, DefaultProvider: "codebuddy"},
			"custom":    {Name: "custom", Dialect: catalog.DialectClaudeCode, DefaultProvider: "custom-provider"},
		},
		providers: map[string]catalog.Provider{
			"anthropic-sub":     {Name: "anthropic-sub", CompatibleDialects: []catalog.Dialect{catalog.DialectClaudeCode}},
			"kimi-coding":       {Name: "kimi-coding", CompatibleDialects: []catalog.Dialect{catalog.DialectClaudeCode}},
			"codebuddy":         {Name: "codebuddy", CompatibleDialects: []catalog.Dialect{catalog.DialectClaudeCode}, UseClientBinary: true},
			"custom-provider":   {Name: "custom-provider", CompatibleDialects: []catalog.Dialect{catalog.DialectClaudeCode}},
			"incompatible-prov": {Name: "incompatible-prov", CompatibleDialects: []catalog.Dialect{catalog.DialectCodex}},
		},
	}
}

func (r *fakeRegistry) LookupDescriptor(name string) (catalog.Client, error) {
	if c, ok := r.clients[name]; ok {
		return c, nil
	}
	return catalog.Client{}, fmt.Errorf("unknown client descriptor %q; available: claude, codebuddy, custom", name)
}

func (r *fakeRegistry) ResolveBinding(clientName, providerName string) (catalog.Client, catalog.Provider, error) {
	client, ok := r.clients[clientName]
	if !ok {
		return catalog.Client{}, catalog.Provider{}, fmt.Errorf("unknown client descriptor %q", clientName)
	}
	if providerName == "" {
		providerName = client.DefaultProvider
	}
	provider, ok := r.providers[providerName]
	if !ok {
		return catalog.Client{}, catalog.Provider{}, fmt.Errorf("unknown provider binding %q; available: anthropic-sub, kimi-coding, codebuddy, custom-provider, incompatible-prov", providerName)
	}
	if !providerSupportsDialect(provider, client.Dialect) {
		return catalog.Client{}, catalog.Provider{}, fmt.Errorf("provider binding %q is not compatible with dialect %q (client %q); supported dialects: %s", providerName, client.Dialect, clientName, dialectList(provider.CompatibleDialects))
	}
	return client, provider, nil
}

func providerSupportsDialect(p catalog.Provider, d catalog.Dialect) bool {
	for _, c := range p.CompatibleDialects {
		if c == d {
			return true
		}
	}
	return false
}

func dialectList(dialects []catalog.Dialect) string {
	parts := make([]string, 0, len(dialects))
	for _, d := range dialects {
		parts = append(parts, string(d))
	}
	return strings.Join(parts, ", ")
}

// noopCredentialCallbacks satisfy CredentialCallbacks without filesystem I/O.
func noopCredentialCallbacks() CredentialCallbacks {
	return CredentialCallbacks{
		ResolveSecret:             func(ref *string) (*string, bool, error) { return nil, false, nil },
		ResolveProviderCredential: func(providerID string) (string, bool) { return "", false },
		IsManagedProvider:         func(providerID string) bool { return false },
	}
}

func TestResolveCatalogHitCCK(t *testing.T) {
	reg := newFakeRegistry()
	input := InputProfile{
		Name:     "cck",
		Client:   "claude",
		Provider: "kimi-coding",
	}
	out, err := Resolve(input, reg, Callbacks{Credential: noopCredentialCallbacks()})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Compatibility != CompatibilityNone {
		t.Fatalf("expected CompatibilityNone, got %q", out.Compatibility)
	}
	if out.Client.Name != "claude" {
		t.Fatalf("expected client claude, got %q", out.Client.Name)
	}
	if out.Provider.Name != "kimi-coding" {
		t.Fatalf("expected provider kimi-coding, got %q", out.Provider.Name)
	}
	if out.Credential.TargetEnv != "ANTHROPIC_API_KEY" {
		t.Fatalf("expected kimi ANTHROPIC_API_KEY, got %q", out.Credential.TargetEnv)
	}
}

func TestResolveCatalogHitCodeBuddyDefault(t *testing.T) {
	reg := newFakeRegistry()
	input := InputProfile{
		Name:   "cb-ds",
		Client: "codebuddy",
		// provider omitted -> uses catalog default "codebuddy"
	}
	out, err := Resolve(input, reg, Callbacks{Credential: noopCredentialCallbacks()})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Compatibility != CompatibilityNone {
		t.Fatalf("expected CompatibilityNone, got %q", out.Compatibility)
	}
	if out.Client.Name != "codebuddy" {
		t.Fatalf("expected client codebuddy, got %q", out.Client.Name)
	}
	if out.Provider.Name != "codebuddy" {
		t.Fatalf("expected provider codebuddy, got %q", out.Provider.Name)
	}
	if out.Credential.TargetEnv != "ANTHROPIC_AUTH_TOKEN" {
		t.Fatalf("expected ANTHROPIC_AUTH_TOKEN, got %q", out.Credential.TargetEnv)
	}
}

func TestResolveUserCustomClientProvider(t *testing.T) {
	reg := newFakeRegistry()
	input := InputProfile{
		Name:     "my-custom",
		Client:   "custom",
		Provider: "custom-provider",
	}
	out, err := Resolve(input, reg, Callbacks{Credential: noopCredentialCallbacks()})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Compatibility != CompatibilityNone {
		t.Fatalf("expected CompatibilityNone, got %q", out.Compatibility)
	}
	if out.Client.Name != "custom" || out.Provider.Name != "custom-provider" {
		t.Fatalf("expected custom/custom-provider, got %q/%q", out.Client.Name, out.Provider.Name)
	}
}

func TestResolveMissingProviderBinding(t *testing.T) {
	reg := newFakeRegistry()
	input := InputProfile{
		Name:     "ccc",
		Client:   "claude",
		Provider: "anthropic", // not registered in catalog
	}
	out, err := Resolve(input, reg, Callbacks{Credential: noopCredentialCallbacks()})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Compatibility != CompatibilityProviderUnregistered {
		t.Fatalf("expected CompatibilityProviderUnregistered, got %q", out.Compatibility)
	}
	// catalog error must not leak as a returned Go error.
	if out.Client.Name != "" || out.Provider.Name != "" {
		t.Fatalf("expected empty client/provider in compatibility mode, got %q/%q", out.Client.Name, out.Provider.Name)
	}
}

func TestResolveDialectIncompatible(t *testing.T) {
	reg := newFakeRegistry()
	input := InputProfile{
		Name:     "bad-dialect",
		Client:   "claude",
		Provider: "incompatible-prov", // only codex dialect
	}
	out, err := Resolve(input, reg, Callbacks{Credential: noopCredentialCallbacks()})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Compatibility != CompatibilityDialectIncompatible {
		t.Fatalf("expected CompatibilityDialectIncompatible, got %q", out.Compatibility)
	}
}

func TestResolveClonesMutableMaps(t *testing.T) {
	reg := newFakeRegistry()
	inputEnv := map[string]string{"EXISTING": "1"}
	inputSettings := map[string]interface{}{"key": "v"}
	input := InputProfile{
		Name:     "cck",
		Client:   "claude",
		Provider: "kimi-coding",
		Env:      inputEnv,
		Settings: inputSettings,
	}
	out, err := Resolve(input, reg, Callbacks{Credential: noopCredentialCallbacks()})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Mutating input maps must not affect the resolved copy.
	inputEnv["EXISTING"] = "mutated"
	inputEnv["NEW"] = "x"
	inputSettings["key"] = "mutated"
	if out.Env["EXISTING"] != "1" {
		t.Fatalf("resolved env shared mutable state: %q", out.Env["EXISTING"])
	}
	if _, ok := out.Env["NEW"]; ok {
		t.Fatalf("resolved env reflected input mutation")
	}
	if out.Settings["key"] != "v" {
		t.Fatalf("resolved settings shared mutable state: %v", out.Settings["key"])
	}
}

// TestResolveCatalogDefaultRegistry proves that the built-in DefaultRegistry
// now resolves the dispatchable built-in profiles cleanly (CompatibilityNone).
// ccc anthropic, ccg zhipu-coding, cck kimi, codebuddy default, codex,
// and opencode default all classify without leaking into compatibility modes.
func TestResolveCatalogDefaultRegistry(t *testing.T) {
	reg := catalog.DefaultRegistry()
	cb := noopCredentialCallbacks()

	tests := []struct {
		name       string
		client     string
		provider   string
		wantClient string
		wantProv   string
		// wantTargetEnv reflects CredentialTargetEnv: only kimi-coding uses
		// ANTHROPIC_API_KEY; the rest use ANTHROPIC_AUTH_TOKEN.
		wantTargetEnv string
	}{
		{name: "ccc", client: "claude", provider: "anthropic", wantClient: "claude", wantProv: "anthropic", wantTargetEnv: "ANTHROPIC_AUTH_TOKEN"},
		{name: "ccg", client: "claude", provider: "zhipu-coding", wantClient: "claude", wantProv: "zhipu-coding", wantTargetEnv: "ANTHROPIC_AUTH_TOKEN"},
		{name: "cck", client: "claude", provider: "kimi-coding", wantClient: "claude", wantProv: "kimi-coding", wantTargetEnv: "ANTHROPIC_API_KEY"},
		{name: "codebuddy-default", client: "codebuddy", provider: "", wantClient: "codebuddy", wantProv: "codebuddy", wantTargetEnv: "ANTHROPIC_AUTH_TOKEN"},
		{name: "codex", client: "codex", provider: "codex", wantClient: "codex", wantProv: "codex", wantTargetEnv: "ANTHROPIC_AUTH_TOKEN"},
		{name: "opencode-default", client: "opencode", provider: "", wantClient: "opencode", wantProv: "opencode-native", wantTargetEnv: "ANTHROPIC_AUTH_TOKEN"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			input := InputProfile{
				Name:     tc.name,
				Client:   tc.client,
				Provider: tc.provider,
			}
			out, err := Resolve(input, reg, Callbacks{Credential: cb})
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if out.Compatibility != CompatibilityNone {
				t.Fatalf("expected CompatibilityNone, got %q", out.Compatibility)
			}
			if out.Client.Name != tc.wantClient {
				t.Fatalf("expected client %q, got %q", tc.wantClient, out.Client.Name)
			}
			if out.Provider.Name != tc.wantProv {
				t.Fatalf("expected provider %q, got %q", tc.wantProv, out.Provider.Name)
			}
			if out.Credential.TargetEnv != tc.wantTargetEnv {
				t.Fatalf("expected target env %q, got %q", tc.wantTargetEnv, out.Credential.TargetEnv)
			}
		})
	}
}
