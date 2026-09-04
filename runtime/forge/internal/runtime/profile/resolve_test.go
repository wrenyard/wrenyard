package profile

import (
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/schema"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

func TestResolveDispatchConsumesGatewayPlanWithoutProviderCredential(t *testing.T) {
	resolved, err := ResolveDispatch(
		InputProfile{Name: "cc-kimi", Client: "legacy", Provider: "legacy", Env: map[string]string{}},
		DispatchPlan{Client: "claude", Provider: "kimi-coding", Model: "k3", Mode: "gateway", Protocol: catalog.GatewayProtocolAnthropic},
		catalog.Client{Name: "claude", Dialect: catalog.DialectClaudeCode},
		schema.Provider{Name: "kimi-coding", CredentialResolver: schema.CredentialResolverForgeManaged},
		Callbacks{Credential: CredentialCallbacks{
			ResolveSecret: func(*string) (*string, bool, error) { return nil, false, nil },
			ResolveProviderCredential: func(string) (string, bool) {
				t.Fatal("gateway dispatch must not resolve the upstream credential in Forge")
				return "", false
			},
			IsManagedProvider: func(string) bool { return true },
		}},
	)
	if err != nil {
		t.Fatal(err)
	}
	if !resolved.Provider.GatewayRouted || resolved.Provider.DefaultModel != "k3" {
		t.Fatalf("unexpected provider plan: %+v", resolved.Provider)
	}
	if got := resolved.Env["ANTHROPIC_MODEL"]; got != "k3" {
		t.Fatalf("ANTHROPIC_MODEL = %q, want k3", got)
	}
}

func TestResolveDispatchResolvesNativeCredential(t *testing.T) {
	resolved, err := ResolveDispatch(
		InputProfile{Name: "codex-sol", Env: map[string]string{}},
		DispatchPlan{Client: "codex", Provider: "codex", Model: "gpt-5.6-sol", Mode: "native"},
		catalog.Client{Name: "codex", Dialect: catalog.DialectCodex},
		schema.Provider{Name: "codex", CredentialResolver: schema.CredentialResolverCodex},
		Callbacks{Credential: CredentialCallbacks{
			ResolveSecret: func(*string) (*string, bool, error) { return nil, false, nil },
			ResolveProviderCredential: func(provider string) (string, bool) {
				if provider != "codex" {
					t.Fatalf("provider = %q", provider)
				}
				return "native-token", true
			},
			IsManagedProvider: func(string) bool { return false },
		}},
	)
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Provider.GatewayRouted || resolved.Credential.Value != "native-token" {
		t.Fatalf("unexpected native resolution: %+v", resolved)
	}
}

func TestResolveDispatchRejectsIncompletePlan(t *testing.T) {
	_, err := ResolveDispatch(InputProfile{Name: "broken"}, DispatchPlan{}, catalog.Client{}, schema.Provider{}, Callbacks{})
	if err == nil {
		t.Fatal("expected incomplete dispatch plan error")
	}
}
