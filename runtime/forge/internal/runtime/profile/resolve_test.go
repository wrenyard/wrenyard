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

func TestResolveDispatchUsesDaemonResolvedCodeBuddyUpstreamModel(t *testing.T) {
	resolved, err := ResolveDispatch(
		InputProfile{
			Name: "cb-hy", Client: "codebuddy", Provider: "codebuddy",
			Launcher: map[string]interface{}{"default_args": []interface{}{"--model", "hy4-preview"}},
		},
		DispatchPlan{Client: "codebuddy", Provider: "codebuddy", Model: "hy4-preview-ioa", Mode: "native"},
		catalog.Client{Name: "codebuddy", Dialect: catalog.DialectCodeBuddy},
		schema.Provider{Name: "codebuddy", CredentialResolver: schema.CredentialResolverCodeBuddy},
		Callbacks{Credential: CredentialCallbacks{
			ResolveSecret:             func(*string) (*string, bool, error) { return nil, false, nil },
			ResolveProviderCredential: func(string) (string, bool) { return "native-token", true },
			IsManagedProvider:         func(string) bool { return false },
		}},
	)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"--model", "hy4-preview-ioa"}
	if len(resolved.Launcher.DefaultArgs) != len(want) {
		t.Fatalf("default args = %#v, want %#v", resolved.Launcher.DefaultArgs, want)
	}
	for i := range want {
		if resolved.Launcher.DefaultArgs[i] != want[i] {
			t.Fatalf("default args = %#v, want %#v", resolved.Launcher.DefaultArgs, want)
		}
	}
	if resolved.Provider.DefaultModel != "hy4-preview-ioa" {
		t.Fatalf("provider model = %q, want final upstream model", resolved.Provider.DefaultModel)
	}
}

func TestResolveDispatchRejectsIncompletePlan(t *testing.T) {
	_, err := ResolveDispatch(InputProfile{Name: "broken"}, DispatchPlan{}, catalog.Client{}, schema.Provider{}, Callbacks{})
	if err == nil {
		t.Fatal("expected incomplete dispatch plan error")
	}
}
