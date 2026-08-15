package discovery

import (
	"encoding/json"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/auth"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

// noInferenceClientBinaryRegistry returns a registry containing a public
// no-inference client-binary provider plus an internal opencode-native
// binding that must stay hidden from public provider listings.
func noInferenceClientBinaryRegistry() *catalog.Registry {
	reg := catalog.NewRegistry()
	reg.RegisterBinding(catalog.Provider{
		Name: "codebuddy", Kind: "custom",
		CompatibleDialects: []catalog.Dialect{catalog.DialectCodeBuddy},
		CredentialResolver: catalog.CredentialResolverCodeBuddy,
		UseClientBinary:    true,
	})
	reg.RegisterBinding(catalog.Provider{
		Name: "opencode-native", Kind: "builtin",
		CompatibleDialects: []catalog.Dialect{catalog.DialectOpenCode},
	})
	return reg
}

func providerDepsForRegistry(reg *catalog.Registry, authenticated map[string]bool) ProviderDeps {
	return ProviderDeps{
		CatalogRegistry: reg,
		AuthStatus: func(providerID string) auth.ProviderAuthStatus {
			status := auth.ProviderAuthStatus{ProviderID: providerID}
			if authenticated[providerID] {
				status.Kind = auth.ResolverCodeBuddy
				status.Resolver = auth.ResolverCodeBuddy
				status.OK = true
				status.Detail = "authenticated"
			}
			return status
		},
		HasFlag: func(args []string, flag string) bool {
			for _, a := range args {
				if a == flag {
					return true
				}
			}
			return false
		},
		PrintJSON: func(value interface{}) int { return 0 },
	}
}

func TestProvidersListIncludesNoInferenceClientBinaryProvider(t *testing.T) {
	reg := noInferenceClientBinaryRegistry()
	deps := providerDepsForRegistry(reg, map[string]bool{"codebuddy": true})
	var raw []byte
	deps.PrintJSON = func(value interface{}) int {
		b, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		raw = b
		return 0
	}
	if code := ProvidersCommand(deps, []string{"list", "--json"}); code != 0 {
		t.Fatalf("list exit code = %d, want 0", code)
	}
	var entries []struct {
		ID      string `json:"id"`
		APIKind string `json:"api_kind"`
		AuthOK  bool   `json:"auth_ok"`
	}
	if err := json.Unmarshal(raw, &entries); err != nil {
		t.Fatalf("unmarshal list output: %v", err)
	}
	// The no-inference client-binary provider is public; opencode-native is not.
	if len(entries) != 1 || entries[0].ID != "codebuddy" {
		t.Fatalf("list entries = %#v, want only codebuddy (opencode-native excluded)", entries)
	}
	if !entries[0].AuthOK {
		t.Fatal("codebuddy auth_ok should be true (resolved via CredentialSource without inference)")
	}
	if entries[0].APIKind != "" {
		t.Fatalf("codebuddy api_kind = %q, want empty (no inference transport)", entries[0].APIKind)
	}
}

func TestProvidersDescribeIncludesNoInferenceClientBinaryProvider(t *testing.T) {
	reg := noInferenceClientBinaryRegistry()
	deps := providerDepsForRegistry(reg, nil)
	var raw []byte
	deps.PrintJSON = func(value interface{}) int {
		b, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		raw = b
		return 0
	}
	if code := ProvidersCommand(deps, []string{"describe", "--json"}); code != 0 {
		t.Fatalf("describe exit code = %d, want 0", code)
	}
	var descs []struct {
		ID     string   `json:"id"`
		RawLLM []string `json:"raw_llm"`
	}
	if err := json.Unmarshal(raw, &descs); err != nil {
		t.Fatalf("unmarshal describe output: %v", err)
	}
	if len(descs) != 1 || descs[0].ID != "codebuddy" {
		t.Fatalf("describe entries = %#v, want only codebuddy (opencode-native excluded)", descs)
	}
	if len(descs[0].RawLLM) != 0 {
		t.Fatalf("codebuddy raw_llm = %#v, want none", descs[0].RawLLM)
	}
}

func TestProvidersAuthLoginRejectedForNativeClientBinaryProvider(t *testing.T) {
	reg := noInferenceClientBinaryRegistry()
	deps := providerDepsForRegistry(reg, nil)
	loginCalled := false
	deps.Auth.ProviderLogin = func(providerID string) error {
		loginCalled = true
		return nil
	}
	if code := ProvidersCommand(deps, []string{"auth", "login", "codebuddy"}); code != 2 {
		t.Fatalf("auth login exit code = %d, want 2 (not Forge-managed)", code)
	}
	if loginCalled {
		t.Fatal("login must not be invoked for a non-Forge-managed native provider")
	}
}
