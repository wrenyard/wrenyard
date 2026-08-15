package driver

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/bashgate"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

func capabilityBashPlanRequest(t *testing.T, family string, mode catalog.PermissionMode, rule catalog.BashRule) PlanRequest {
	t.Helper()
	resolver := func([]string) (CapabilityResult, error) {
		return CapabilityResult{BashGate: CapabilityBashGate{Cap: []catalog.BashRule{rule}}}, nil
	}

	switch family {
	case "codex":
		req := codexPlanRequest(t, mode)
		req.Capabilities = []string{"test-capability"}
		req.ResolveCapabilities = resolver
		return req
	case "claude", "codebuddy":
		desc, err := catalog.DefaultRegistry().LookupDescriptor(family)
		if err != nil {
			t.Fatal(err)
		}
		return PlanRequest{
			Spec: ProfileSpec{
				Name: family + "-capability", Client: family,
				Launcher:     map[string]interface{}{"command": "go"},
				Env:          map[string]string{},
				ClientDesc:   desc,
				ForgeDataDir: t.TempDir(),
			},
			Prompt: "inspect capability", WorkDir: t.TempDir(), Permission: mode,
			Capabilities: []string{"test-capability"}, ResolveCapabilities: resolver,
		}
	case "grok":
		req := grokPlanRequest(t, mode)
		req.Capabilities = []string{"test-capability"}
		req.ResolveCapabilities = resolver
		return req
	case "opencode":
		return PlanRequest{
			Spec: ProfileSpec{
				Name: "opencode-capability", Client: "opencode",
				Launcher:     map[string]interface{}{"command": "opencode"},
				Env:          map[string]string{},
				ForgeDataDir: t.TempDir(),
				ClientDesc: catalog.Client{
					Name: "opencode", Dialect: catalog.DialectOpenCode,
					PermissionAdapter: catalog.PermissionAdapterOpenCode,
				},
			},
			Prompt: "inspect capability", WorkDir: t.TempDir(), Permission: mode,
			Capabilities: []string{"test-capability"}, ResolveCapabilities: resolver,
		}
	default:
		t.Fatalf("unknown family %q", family)
		return PlanRequest{}
	}
}

func TestCapabilityBashPlanValidationFailsClosedForEveryEncoderAndMode(t *testing.T) {
	invalid := []string{
		"*", "foo*", "foo * bar", "foo * *", "foo **",
		"foo | bar", "foo > out", "foo $(bar)", "foo \"bar\"", "foo\nbar",
	}
	for _, family := range []string{"codex", "claude", "codebuddy", "grok", "opencode"} {
		for _, mode := range []catalog.PermissionMode{catalog.PermissionReadonly, catalog.PermissionEdit, catalog.PermissionYolo} {
			for _, pattern := range invalid {
				t.Run(family+"/"+string(mode)+"/"+pattern, func(t *testing.T) {
					req := capabilityBashPlanRequest(t, family, mode, catalog.BashRule{Pattern: pattern})
					plan, err := BuildPlan(req)
					if err == nil || !strings.Contains(err.Error(), "unsafe capability Bash rule") {
						t.Fatalf("invalid capability plan error = %v; plan=%+v", err, plan)
					}
				})
			}
		}
	}
}

func TestCapabilityBashPlansEncodeNotesmdAndLiteralControls(t *testing.T) {
	for _, family := range []string{"codex", "claude", "codebuddy", "grok", "opencode"} {
		for _, mode := range []catalog.PermissionMode{catalog.PermissionReadonly, catalog.PermissionEdit} {
			for _, pattern := range []string{"notesmd-cli *", "notesmd-cli list"} {
				t.Run(family+"/"+string(mode)+"/"+pattern, func(t *testing.T) {
					req := capabilityBashPlanRequest(t, family, mode, catalog.BashRule{Pattern: pattern})
					plan, err := BuildPlan(req)
					if err != nil {
						t.Fatal(err)
					}
					switch family {
					case "codex":
						if mode != catalog.PermissionYolo {
							policyPath := codexMCPPolicyPathFromPlan(t, plan)
							encoded, err := os.ReadFile(policyPath)
							if err != nil {
								t.Fatal(err)
							}
							command := pattern
							if strings.HasSuffix(command, " *") {
								command = strings.TrimSuffix(command, " *") + " list"
							}
							if reason, allowed := bashgate.AuthorizeCommand(bashgate.ClientCodex, strings.TrimSpace(string(encoded)), command, req.WorkDir); !allowed {
								t.Fatalf("Codex policy did not encode %q: %s", pattern, reason)
							}
						}
					case "claude", "codebuddy":
						if !containsArg(plan.Command, catalog.EncodeBashRule(catalog.BashRule{Pattern: pattern})) {
							t.Fatalf("Claude-family plan did not encode %q: %v", pattern, plan.Command)
						}
					case "grok":
						if !containsOrderedArgs(plan.Command, "--allow", catalog.EncodeBashRule(catalog.BashRule{Pattern: pattern})) {
							t.Fatalf("Grok plan did not encode %q: %v", pattern, plan.Command)
						}
					case "opencode":
						var bash map[string]string
						if err := json.Unmarshal([]byte(plan.Env[bashgate.OpenCodeBashPermissionEnv]), &bash); err != nil {
							t.Fatal(err)
						}
						if bash[pattern] != "allow" {
							t.Fatalf("OpenCode plan decision for %q = %q", pattern, bash[pattern])
						}
					}
				})
			}
		}
	}
}
