package profile

import (
	"encoding/json"
	"strings"
	"testing"
)

// fakeSecretInput builds CredentialCallbacks from simple in-memory callbacks.
func fakeCredentialCallbacks(secretVal *string, secretErr error, secretProfileLiteral bool, credValue string, credOK bool, managed bool) CredentialCallbacks {
	return CredentialCallbacks{
		ResolveSecret: func(ref *string) (*string, bool, error) {
			return secretVal, secretProfileLiteral, secretErr
		},
		ResolveProviderCredential: func(providerID string) (string, bool) {
			return credValue, credOK
		},
		IsManagedProvider: func(providerID string) bool {
			return managed
		},
	}
}

func TestCredentialSecretRefWins(t *testing.T) {
	v := "secret-value"
	cb := fakeCredentialCallbacks(&v, nil, false, "ignored", true, false)
	plan, err := PlanCredential(InputProfile{Provider: "anthropic", SecretRef: strptr("env:X")}, cb)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if plan.Value != "secret-value" {
		t.Fatalf("expected secret-value, got %q", plan.Value)
	}
	if plan.Source != "secret_ref" {
		t.Fatalf("expected source secret_ref, got %q", plan.Source)
	}
}

func TestCredentialProfileLiteral(t *testing.T) {
	// ResolveSecret returns nil value with isProfileLiteral=true.
	cb := fakeCredentialCallbacks(nil, nil, true, "", false, false)
	ref := "profile:fixed-token"
	plan, err := PlanCredential(InputProfile{Provider: "anthropic", SecretRef: &ref}, cb)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if plan.Value != ref {
		t.Fatalf("expected profile literal %q, got %q", ref, plan.Value)
	}
	if plan.Source != "secret_ref_profile_literal" {
		t.Fatalf("expected profile_literal source, got %q", plan.Source)
	}
}

func TestCredentialSystemNoInjection(t *testing.T) {
	cb := fakeCredentialCallbacks(nil, nil, false, "", false, false)
	ref := "system:noop"
	plan, err := PlanCredential(InputProfile{Provider: "anthropic", SecretRef: &ref}, cb)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if plan.Value != "" {
		t.Fatalf("expected no injection for system:, got %q", plan.Value)
	}
}

func TestCredentialManagedProviderFailClosed(t *testing.T) {
	// No secret_ref, raw Provider set, no credential found, managed provider.
	cb := fakeCredentialCallbacks(nil, nil, false, "", false, true)
	_, err := PlanCredential(InputProfile{Provider: "kimi-coding"}, cb)
	if err == nil {
		t.Fatal("expected fail-closed error for managed provider with no credential")
	}
	want := `no credential for provider "kimi-coding"; run forge auth login kimi-coding`
	if err.Error() != want {
		t.Fatalf("expected exact error %q, got %q", want, err.Error())
	}
}

func TestCredentialUnmanagedMissingAllowed(t *testing.T) {
	// No secret_ref, raw Provider set, no credential found, unmanaged provider.
	cb := fakeCredentialCallbacks(nil, nil, false, "", false, false)
	plan, err := PlanCredential(InputProfile{Provider: "anthropic"}, cb)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if plan.Value != "" {
		t.Fatalf("expected empty value for unmanaged missing, got %q", plan.Value)
	}
}

func TestCredentialKimiTargetEnv(t *testing.T) {
	cb := fakeCredentialCallbacks(nil, nil, false, "", false, false)
	plan, err := PlanCredential(InputProfile{Provider: "kimi-coding"}, cb)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if plan.TargetEnv != "ANTHROPIC_API_KEY" {
		t.Fatalf("expected ANTHROPIC_API_KEY for kimi, got %q", plan.TargetEnv)
	}
}

func TestCredentialNonKimiTargetEnv(t *testing.T) {
	cb := fakeCredentialCallbacks(nil, nil, false, "", false, false)
	plan, err := PlanCredential(InputProfile{Provider: "anthropic"}, cb)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if plan.TargetEnv != "ANTHROPIC_AUTH_TOKEN" {
		t.Fatalf("expected ANTHROPIC_AUTH_TOKEN for non-kimi, got %q", plan.TargetEnv)
	}
}

func TestCredentialNoProviderNoCatalogDefaultLookup(t *testing.T) {
	// Empty provider + callback that would only return a value for a known
	// provider: with empty provider, ResolveProviderCredential must NOT be
	// invoked to trigger credential lookup. A bogus managed flag must not fire.
	invoked := false
	cb := CredentialCallbacks{
		ResolveSecret: func(ref *string) (*string, bool, error) { return nil, false, nil },
		ResolveProviderCredential: func(providerID string) (string, bool) {
			invoked = true
			return "", false
		},
		IsManagedProvider: func(providerID string) bool { return true },
	}
	plan, err := PlanCredential(InputProfile{Provider: ""}, cb)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if invoked {
		t.Fatal("provider credential lookup must not run for empty provider")
	}
	if plan.Value != "" {
		t.Fatalf("expected no credential for empty provider, got %q", plan.Value)
	}
}

func TestCredentialValueAbsentFromJSON(t *testing.T) {
	plan := CredentialPlan{
		TargetEnv: "ANTHROPIC_AUTH_TOKEN",
		Value:     "super-secret",
		Source:    "provider",
	}
	data, err := json.Marshal(plan)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	s := string(data)
	if strings.Contains(s, "super-secret") {
		t.Fatalf("credential Value leaked into JSON: %s", s)
	}
	if !strings.Contains(s, "target_env") {
		t.Fatalf("expected target_env in JSON: %s", s)
	}
	if !strings.Contains(s, "source") {
		t.Fatalf("expected source in JSON: %s", s)
	}
}

func strptr(s string) *string {
	return &s
}
