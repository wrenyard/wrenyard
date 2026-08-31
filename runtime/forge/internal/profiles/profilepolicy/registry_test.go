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
	for _, id := range []string{"cb-hy", "cb-ds", "cb-dsf", "cc-kimi", "cc-glm", "cc-glmf", "gk-glmf", "gk-kimi", "codex-sol", "codex-terra", "codex-luna", "codex-spark", "cur-grok", "cur-kimi"} {
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
		{name: "fast", want: []string{"cb-hy", "cb-dsf", "gk-glmf"}},
		{name: "general", want: []string{"cur-grok", "cb-ds", "gk-glm"}},
		{name: "ultra", want: []string{"cur-kimi", "gk-kimi", "codex-sol"}},
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
	if !res.OK || res.ProfileID != "cb-hy" {
		t.Fatalf("expected cb-hy, got %+v", res)
	}
	if got, want := res.CandidateIDs, []string{"cb-hy", "cb-dsf", "gk-glmf"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("candidate snapshot=%v want %v", got, want)
	}
}

func TestResolverUltraCandidateFallback(t *testing.T) {
	reg := NewRegistry()

	deps := Dependencies{
		IsProfileEffective:      func(id string) bool { return true },
		CanonicalPoolForProfile: testCanonicalPool,
		CanonicalPoolUsagePct:   func(pool string) int { return 0 },
	}

	// ultra must pick cur-kimi first, and fall back within the policy to
	// gk-kimi when the cursor pool is exhausted (never to another policy).
	ultra, err := reg.Lookup("ultra")
	if err != nil {
		t.Fatal(err)
	}
	if res := Resolve(ResolveRequest{Policy: ultra}, deps, nil); !res.OK || res.ProfileID != "cur-kimi" {
		t.Fatalf("ultra: expected cur-kimi first, got %+v", res)
	}

	depsExhaustedCursor := Dependencies{
		IsProfileEffective:      func(id string) bool { return true },
		CanonicalPoolForProfile: testCanonicalPool,
		CanonicalPoolUsagePct: func(pool string) int {
			if pool == "cursor" {
				return 95
			}
			return 0
		},
	}
	fallback := Resolve(ResolveRequest{Policy: ultra}, depsExhaustedCursor, nil)
	if !fallback.OK || fallback.ProfileID != "gk-kimi" {
		t.Fatalf("ultra: expected gk-kimi fallback when cursor pool exhausted, got %+v", fallback)
	}
	if fallback.PolicyName != "ultra" {
		t.Fatalf("ultra: policy name = %q, want ultra", fallback.PolicyName)
	}
}

func TestResolverThresholdDefault90(t *testing.T) {
	reg := NewRegistry()
	p, err := reg.Lookup("fast")
	if err != nil {
		t.Fatal(err)
	}
	// pool-hy pool at 95 (over default 90): cb-hy is exhausted.
	deps := Dependencies{
		IsProfileEffective:      func(id string) bool { return true },
		CanonicalPoolForProfile: testCanonicalPool,
		CanonicalPoolUsagePct: func(pool string) int {
			if pool == "pool-hy" {
				return 95
			}
			return 0
		},
	}
	req := ResolveRequest{Policy: p}
	res := Resolve(req, deps, nil)
	if !res.OK || res.ProfileID != "cb-dsf" {
		t.Fatalf("expected cb-dsf (cb-hy has exhausted pool-hy pool), got %+v", res)
	}
}

func TestResolverThresholdOverride(t *testing.T) {
	reg := NewRegistry()
	p, err := reg.Lookup("fast")
	if err != nil {
		t.Fatal(err)
	}
	// Override cb-hy threshold to 99, so 95 usage still leaves it available.
	deps := Dependencies{
		IsProfileEffective:      func(id string) bool { return true },
		CanonicalPoolForProfile: testCanonicalPool,
		CanonicalPoolUsagePct: func(pool string) int {
			if pool == "pool-hy" {
				return 95
			}
			return 0
		},
	}
	req := ResolveRequest{Policy: p}
	res := Resolve(req, deps, map[string]int{"cb-hy": 99})
	if !res.OK || res.ProfileID != "cb-hy" {
		t.Fatalf("expected cb-hy with override threshold 99, got %+v", res)
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
	case "cb-hy":
		return "pool-hy"
	case "cb-ds", "cb-dsf":
		return "pool-a"
	case "codex-sol", "codex-luna":
		return "codex"
	case "codex-spark":
		return "codex-spark"
	case "gk-glm", "gk-glmf", "gk-kimi":
		return "gk"
	case "cur-grok", "cur-kimi":
		return "cursor"
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
	// cur-grok has cursor pool, cb-ds has pool-a, gk-glm has gk pool.
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
	if res.Suggestions[0] != "cur-grok" {
		t.Fatalf("first suggestion should be cur-grok (cursor pool), got %q", res.Suggestions[0])
	}
	if res.Suggestions[1] != "cb-ds" {
		t.Fatalf("second suggestion should be cb-ds (pool-a), got %q", res.Suggestions[1])
	}
	if res.Suggestions[2] != "gk-glm" {
		t.Fatalf("third suggestion should be gk-glm (gk pool), got %q", res.Suggestions[2])
	}
}
