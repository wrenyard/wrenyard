package discovery

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/auth"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/cursor"
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

func cursorRegistry() *catalog.Registry {
	reg := catalog.NewRegistry()
	reg.RegisterBinding(catalog.Provider{
		Name:            "cursor",
		Kind:            "custom",
		UseClientBinary: true,
	})
	reg.RegisterBinding(catalog.Provider{
		Name:            "codebuddy",
		Kind:            "custom",
		UseClientBinary: true,
	})
	return reg
}

func TestProvidersListProjectsCursorModelAvailabilityOnce(t *testing.T) {
	reg := cursorRegistry()
	deps := providerDepsForRegistry(reg, map[string]bool{"cursor": true, "codebuddy": true})
	calls := 0
	deps.CursorModelAvailability = func() (map[string]cursor.Availability, error) {
		calls++
		return map[string]cursor.Availability{
			"arbitrary-team-model": {Status: cursor.StatusBlocked, Reason: cursor.ReasonAdminBlocked},
		}, nil
	}
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
	if calls != 1 {
		t.Fatalf("CursorModelAvailability calls = %d, want 1", calls)
	}
	var entries []struct {
		ID                string                         `json:"id"`
		AuthOK            bool                           `json:"auth_ok"`
		ModelAvailability map[string]cursor.Availability `json:"model_availability"`
	}
	if err := json.Unmarshal(raw, &entries); err != nil {
		t.Fatalf("unmarshal list output: %v", err)
	}
	var cursorAuthOK bool
	var cursorModels map[string]cursor.Availability
	var codebuddyAuthOK bool
	var codebuddyHasModels bool
	for _, entry := range entries {
		switch entry.ID {
		case "cursor":
			cursorAuthOK = entry.AuthOK
			cursorModels = entry.ModelAvailability
		case "codebuddy":
			codebuddyAuthOK = entry.AuthOK
			codebuddyHasModels = entry.ModelAvailability != nil
		}
	}
	if !cursorAuthOK {
		t.Fatal("cursor auth_ok should stay true independent of model policy")
	}
	if cursorModels["arbitrary-team-model"] != (cursor.Availability{Status: cursor.StatusBlocked, Reason: cursor.ReasonAdminBlocked}) {
		t.Fatalf("model_availability = %#v", cursorModels)
	}
	if !codebuddyAuthOK {
		t.Fatal("codebuddy auth_ok should stay true")
	}
	if codebuddyHasModels {
		t.Fatal("codebuddy must not receive model_availability")
	}
}

func TestProvidersListCursorCallbackErrorUnknownWithoutSecrets(t *testing.T) {
	reg := cursorRegistry()
	deps := providerDepsForRegistry(reg, map[string]bool{"cursor": true})
	deps.CursorModelAvailability = func() (map[string]cursor.Availability, error) {
		return nil, fmt.Errorf("token=SECRET_CURSOR_TOKEN path=/secret/cursor/state")
	}
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
	if strings.Contains(string(raw), "SECRET_CURSOR_TOKEN") || strings.Contains(string(raw), "/secret/cursor/state") {
		t.Fatalf("list JSON leaked callback error: %s", raw)
	}
	var entries []struct {
		ID                string                         `json:"id"`
		AuthOK            bool                           `json:"auth_ok"`
		ModelAvailability map[string]cursor.Availability `json:"model_availability"`
	}
	if err := json.Unmarshal(raw, &entries); err != nil {
		t.Fatalf("unmarshal list output: %v", err)
	}
	for _, entry := range entries {
		if entry.ID != "cursor" {
			continue
		}
		if !entry.AuthOK || entry.ModelAvailability == nil || len(entry.ModelAvailability) != 0 {
			t.Fatalf("cursor = %#v, want authenticated with empty/unknown model access", entry)
		}
		return
	}
	t.Fatal("missing cursor provider")
}

func TestProvidersListSkipsCursorCallbackWhenUnauthenticated(t *testing.T) {
	reg := cursorRegistry()
	deps := providerDepsForRegistry(reg, map[string]bool{"cursor": false})
	calls := 0
	deps.CursorModelAvailability = func() (map[string]cursor.Availability, error) {
		calls++
		return map[string]cursor.Availability{"composer-1": {Status: cursor.StatusAvailable}}, nil
	}
	deps.PrintJSON = func(interface{}) int { return 0 }
	if code := ProvidersCommand(deps, []string{"list", "--json"}); code != 0 {
		t.Fatalf("list exit code = %d, want 0", code)
	}
	if calls != 0 {
		t.Fatalf("callback calls = %d, want 0 when unauthenticated", calls)
	}
}
