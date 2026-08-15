package profilepolicy

import (
	"fmt"
	"sort"
)

// DefaultThreshold is the default quota-usage threshold percentage.
const DefaultThreshold = 90

// builtinPolicies is the immutable set of built-in policies.
// Policy ids must not collide with profile ids.
var builtinPolicies = map[string]ProfilePolicy{
	"fast": {
		Name: "fast",
		Candidates: []Candidate{
			{ProfileID: "cb-dsf"},
			{ProfileID: "codex-spark"},
		},
	},
	"general": {
		Name: "general",
		Candidates: []Candidate{
			{ProfileID: "cb-ds"},
			{ProfileID: "gk-glm"},
			{ProfileID: "codex-luna"},
		},
	},
	"ultra": {
		Name: "ultra",
		Candidates: []Candidate{
			{ProfileID: "codex-sol"},
			{ProfileID: "gk-kimi"},
		},
	},
}

// Registry holds the built-in policy definitions.
type Registry struct {
	policies map[string]ProfilePolicy
	order    []string
}

// NewRegistry creates a new policy registry populated with the built-in
// immutable policy set.
func NewRegistry() *Registry {
	r := &Registry{
		policies: make(map[string]ProfilePolicy, len(builtinPolicies)),
		order:    make([]string, 0, len(builtinPolicies)),
	}
	for name, p := range builtinPolicies {
		r.policies[name] = p
		r.order = append(r.order, name)
	}
	sort.Strings(r.order)
	return r
}

// Lookup returns the named policy, or an error if it does not exist.
func (r *Registry) Lookup(name string) (ProfilePolicy, error) {
	if name == "" || name == "auto" {
		return ProfilePolicy{}, fmt.Errorf("unknown policy %q", name)
	}
	p, ok := r.policies[name]
	if !ok {
		return ProfilePolicy{}, fmt.Errorf("unknown policy %q", name)
	}
	return p, nil
}

// List returns known policy names in stable order.
func (r *Registry) List() []string {
	return append([]string(nil), r.order...)
}

// IsReservedPolicy reports whether the id is a known policy name.
func (r *Registry) IsReservedPolicy(id string) bool {
	_, ok := r.policies[id]
	return ok
}
