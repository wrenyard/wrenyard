package profilepolicy

import (
	"reflect"
	"testing"
)

func TestRegistryThreePolicies(t *testing.T) {
	r := NewRegistry()
	if len(r.List()) != 3 {
		t.Fatalf("expected 3 policies, got %d: %v", len(r.List()), r.List())
	}
	for _, name := range []string{"fast", "general", "ultra"} {
		if _, err := r.Lookup(name); err != nil {
			t.Fatalf("expected policy %q to exist: %v", name, err)
		}
	}
}

func TestRegistryPolicyOrderStable(t *testing.T) {
	a := NewRegistry().List()
	b := NewRegistry().List()
	if len(a) != len(b) {
		t.Fatalf("order length mismatch: %v vs %v", a, b)
	}
	for i := range a {
		if a[i] != b[i] {
			t.Fatalf("order mismatch at %d: %q vs %q", i, a[i], b[i])
		}
	}
}

func TestRegistryUnknownPolicy(t *testing.T) {
	r := NewRegistry()
	for _, name := range []string{"", "auto", "nonexistent", "unknown", "strong"} {
		if _, err := r.Lookup(name); err == nil {
			t.Fatalf("expected error for policy %q", name)
		}
	}
}

func TestRegistryProfilePolicyCollision(t *testing.T) {
	r := NewRegistry()
	// Policy ids must not collide with profile ids. Check that
	// IsReservedPolicy returns false for profile-only ids.
	for _, id := range []string{"cb-hy", "cb-ds", "cb-dsf", "cc-kimi", "cc-glm", "codex-sol", "codex-terra", "codex-luna", "codex-spark"} {
		if r.IsReservedPolicy(id) {
			t.Fatalf("profile id %q should not be reserved as a policy name", id)
		}
	}
}

func TestPolicyCandidateMembership(t *testing.T) {
	tests := []struct {
		name string
		want []string
	}{
		{name: "fast", want: []string{"cb-dsf", "codex-spark"}},
		{name: "general", want: []string{"cb-ds", "gk-glm", "codex-luna"}},
		{name: "ultra", want: []string{"codex-sol", "gk-kimi"}},
	}
	r := NewRegistry()
	for _, tt := range tests {
		p, err := r.Lookup(tt.name)
		if err != nil {
			t.Fatal(err)
		}
		got := make([]string, len(p.Candidates))
		for i, c := range p.Candidates {
			got[i] = c.ProfileID
		}
		if !reflect.DeepEqual(got, tt.want) {
			t.Fatalf("%s policy candidates = %v, want %v", tt.name, got, tt.want)
		}
	}
}

func TestResolverCandidateOrdering(t *testing.T) {
	reg := NewRegistry()
	p, err := reg.Lookup("fast")
	if err != nil {
		t.Fatal(err)
	}
	// All candidates effective, all pools below threshold: pick the first.
	deps := Dependencies{
		IsProfileEffective:    func(id string) bool { return true },
		CanonicalPoolUsagePct: func(pool string) int { return 0 },
	}
	req := ResolveRequest{Policy: p}
	res := Resolve(req, deps, nil)
	if !res.OK || res.ProfileID != "cb-dsf" {
		t.Fatalf("expected cb-dsf, got %+v", res)
	}
	if got, want := res.CandidateIDs, []string{"cb-dsf", "codex-spark"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("candidate snapshot=%v want %v", got, want)
	}
}

func TestResolverThresholdDefault90(t *testing.T) {
	reg := NewRegistry()
	p, err := reg.Lookup("fast")
	if err != nil {
		t.Fatal(err)
	}
	// pool-a pool at 95 (over default 90): cb-dsf is exhausted.
	deps := Dependencies{
		IsProfileEffective:      func(id string) bool { return true },
		CanonicalPoolForProfile: testCanonicalPool,
		CanonicalPoolUsagePct: func(pool string) int {
			if pool == "pool-a" {
				return 95
			}
			return 0
		},
	}
	req := ResolveRequest{Policy: p}
	res := Resolve(req, deps, nil)
	if !res.OK || res.ProfileID != "codex-spark" {
		t.Fatalf("expected codex-spark (cb-dsf has exhausted pool-a pool), got %+v", res)
	}
}

func TestResolverThresholdOverride(t *testing.T) {
	reg := NewRegistry()
	p, err := reg.Lookup("fast")
	if err != nil {
		t.Fatal(err)
	}
	// Override cb-dsf threshold to 99, so 95 usage still leaves it available.
	deps := Dependencies{
		IsProfileEffective:      func(id string) bool { return true },
		CanonicalPoolForProfile: testCanonicalPool,
		CanonicalPoolUsagePct: func(pool string) int {
			if pool == "pool-a" {
				return 95
			}
			return 0
		},
	}
	req := ResolveRequest{Policy: p}
	res := Resolve(req, deps, map[string]int{"cb-dsf": 99})
	if !res.OK || res.ProfileID != "cb-dsf" {
		t.Fatalf("expected cb-dsf with override threshold 99, got %+v", res)
	}
}

func TestResolverAllUnavailable(t *testing.T) {
	reg := NewRegistry()
	p, err := reg.Lookup("ultra")
	if err != nil {
		t.Fatal(err)
	}
	// Only candidate is not effective.
	deps := Dependencies{
		IsProfileEffective:      func(id string) bool { return false },
		CanonicalPoolUsagePct:   func(pool string) int { return -1 },
		CanonicalPoolForProfile: testCanonicalPool,
	}
	req := ResolveRequest{Policy: p}
	res := Resolve(req, deps, nil)
	if res.OK {
		t.Fatal("expected resolution to fail when all candidates unavailable")
	}
}

func testCanonicalPool(profileID string) string {
	switch profileID {
	case "cb-ds", "cb-dsf":
		return "pool-a"
	case "codex-sol", "codex-luna":
		return "codex"
	case "codex-spark":
		return "codex-spark"
	case "gk-glm", "gk-kimi":
		return "gk"
	default:
		return ""
	}
}

func TestResolverNoCrossPolicyFallback(t *testing.T) {
	r := NewRegistry()
	fast, _ := r.Lookup("fast")
	// All fast candidates unavailable.
	deps := Dependencies{
		IsProfileEffective:      func(id string) bool { return false },
		CanonicalPoolUsagePct:   func(pool string) int { return -1 },
		CanonicalPoolForProfile: testCanonicalPool,
	}
	req := ResolveRequest{Policy: fast}
	res := Resolve(req, deps, nil)
	if res.OK {
		t.Fatal("resolver must not fall back to another policy")
	}
	// Should still report the input policy name.
	if res.PolicyName != "fast" {
		t.Fatalf("policy name = %q, want fast", res.PolicyName)
	}
}

func TestResolverCanonicalPoolDeduplicatedSuggestions(t *testing.T) {
	reg := NewRegistry()
	p, err := reg.Lookup("general")
	if err != nil {
		t.Fatal(err)
	}
	// cb-ds has pool-a pool, gk-glm has gk pool, codex-luna has codex pool.
	// If all fail, one suggestion per pool should appear in candidate order.
	deps := Dependencies{
		IsProfileEffective:      func(id string) bool { return false },
		CanonicalPoolUsagePct:   func(pool string) int { return -1 },
		CanonicalPoolForProfile: testCanonicalPool,
	}
	req := ResolveRequest{Policy: p}
	res := Resolve(req, deps, nil)
	if res.OK {
		t.Fatal("expected no available candidate")
	}
	if len(res.Suggestions) < 3 {
		t.Fatalf("expected at least 3 deduplicated suggestions, got %v", res.Suggestions)
	}
	if res.Suggestions[0] != "cb-ds" {
		t.Fatalf("first suggestion should be cb-ds (first pool-a pool), got %q", res.Suggestions[0])
	}
	if res.Suggestions[1] != "gk-glm" {
		t.Fatalf("second suggestion should be gk-glm (first gk pool), got %q", res.Suggestions[1])
	}
	if res.Suggestions[2] != "codex-luna" {
		t.Fatalf("third suggestion should be codex-luna (first codex pool), got %q", res.Suggestions[2])
	}
}
