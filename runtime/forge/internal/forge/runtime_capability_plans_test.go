package forge

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/bashgate"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/driver"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/execution"
)

func setupClaudeFamilyCapabilityPlans(t *testing.T) string {
	t.Helper()
	writeCodeBuddyAuthFixture(t, "ioa.example.com", "uid-capability-plans", "synthetic-capability-token")
	home := userHome()
	t.Setenv("FORGE_DSH_BIN", "")
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	setFakeClientsOnPath(t, "claude", "codebuddy")
	setTestAuth(t, "zhipu-coding", "capability-plan-zhipu")
	active := authStatusResolver().CodeBuddyActiveScope()
	if !active.OK || active.Environment != "ioa" || active.Scope == "" {
		t.Fatalf("synthetic capability-plan CodeBuddy fixture did not resolve: %+v", active)
	}
	setCodeBuddyExpectedTuple(t, active.Scope, active.Environment, "hy4-preview-ioa")
	writeCapabilitiesManifest(t, home, `{
  "mcp-only":{"description":"MCP only","mcp_servers":{"capserver":{"command":"cap-server","args":["--stdio"]}}},
  "bash-only":{"description":"Bash only","bash":{"cap":["cap-reader *"]}},
  "external-only":{"description":"External tool only","tools":{"cap":["ExternalReader"]}},
  "collision-team":{"description":"collision","tools":{"cap":["TeamCreate"]}},
  "collision-agent":{"description":"collision","tools":{"cap":["Agent"]}},
  "collision-edit":{"description":"collision","tools":{"cap":["Edit"]}},
  "collision-unencodable":{"description":"collision","tools":{"cap":["EnterPlanMode"]}}
}`)
	return home
}

func prepareClaudeFamilyCapabilityPlan(t *testing.T, profileName, pack string, mode catalog.PermissionMode) ([]string, error) {
	t.Helper()
	plan, family, err := execution.Prepare(execution.Request{
		ProfileName:  profileName,
		Prompt:       "inspect capability composition",
		WorkDir:      t.TempDir(),
		Permission:   mode,
		Clean:        true,
		Capabilities: []string{pack},
	}, executionDependencies())
	if family != "claude" {
		t.Fatalf("%s family = %q, want claude", profileName, family)
	}
	return plan.Command, err
}

// TestClaudeFamilyCapabilityPlansAreYoloForEveryLegacyMode pins the production
// boundary: execution.Prepare normalizes every legacy permission spelling
// (explicit readonly, explicit edit, and the absent default) to YOLO before the
// family planner sees it. YOLO drops the neutral per-mode permission fields
// (--permission-mode/--tools/--allowedTools and the restricted Bash denials)
// because the client itself runs with --dangerously-skip-permissions, but the
// capability pack's MCP servers and the orchestration denials must still be
// present. The dormant restricted encoders are exercised separately below.
func TestClaudeFamilyCapabilityPlansAreYoloForEveryLegacyMode(t *testing.T) {
	setupClaudeFamilyCapabilityPlans(t)
	for _, profileName := range []string{"cc-glm", "cb-hy"} {
		for _, mode := range []catalog.PermissionMode{catalog.PermissionReadonly, catalog.PermissionEdit, catalog.PermissionYolo, ""} {
			for _, pack := range []string{"mcp-only", "bash-only", "notesmd", "external-only", "browser-use"} {
				t.Run(profileName+"/"+string(mode)+"/"+pack, func(t *testing.T) {
					command, err := prepareClaudeFamilyCapabilityPlan(t, profileName, pack, mode)
					if err != nil {
						if strings.Contains(err.Error(), "permission arguments were not found") {
							t.Fatalf("capability finalization depended on pristine argv: %v", err)
						}
						t.Fatal(err)
					}

					// YOLO leaves the neutral tool-scope fields unset; the client
					// bypasses approvals instead of receiving an allowlist.
					if tools := claudeToolsValue(command); tools != "" {
						t.Fatalf("%s %s %s retained restricted --tools scope under YOLO: %q", profileName, mode, pack, tools)
					}
					if contains(command, "--permission-mode") {
						t.Fatalf("%s %s %s retained --permission-mode under YOLO: %v", profileName, mode, pack, command)
					}
					if len(claudeFlagSection(command, "--allowedTools")) != 0 {
						t.Fatalf("%s %s %s retained --allowedTools under YOLO: %v", profileName, mode, pack, command)
					}
					// The capability's Bash rule contributes nothing native under
					// YOLO: unrestricted Bash already covers it.
					if contains(command, "Bash(cap-reader *)") || contains(command, "Bash(notesmd-cli *)") {
						t.Fatalf("%s %s %s encoded a capability Bash allow rule under YOLO: %v", profileName, mode, pack, command)
					}

					// Orchestration denials are client-owned and survive the mode
					// change; they are not part of the neutral restricted policy.
					// Agent is deliberately absent: YOLO grants AccessAgent, so
					// Agent must not be disallowed.
					disallowed := strings.Join(claudeFlagSection(command, "--disallowedTools"), ",")
					for _, denied := range []string{"EnterPlanMode", "TeamCreate", "TeamDelete", "SendMessage"} {
						if !strings.Contains(disallowed, denied) {
							t.Fatalf("%s %s %s lost orchestration denial %q: %v", profileName, mode, pack, denied, command)
						}
					}
					if strings.Contains(disallowed, "Agent") {
						t.Fatalf("%s %s %s disabled Agent under YOLO: %v", profileName, mode, pack, command)
					}
					// The restricted Bash guard belongs to the dormant restricted
					// policy and must not appear in the YOLO plan.
					if strings.Contains(disallowed, "Bash(*$*)") {
						t.Fatalf("%s %s %s retained restricted Bash denials under YOLO: %v", profileName, mode, pack, command)
					}

					// Capabilities remain registered: MCP registrations are a
					// capability contribution, not a permission artifact, so they
					// survive the YOLO boundary.
					switch pack {
					case "mcp-only":
						if !contains(command, "--strict-mcp-config") || !strings.Contains(argAfter(command, "--mcp-config"), `"capserver"`) {
							t.Fatalf("YOLO capability plan lost capserver MCP registration: %v", command)
						}
					case "browser-use":
						if !contains(command, "--strict-mcp-config") || !strings.Contains(argAfter(command, "--mcp-config"), `"browser-use"`) {
							t.Fatalf("YOLO capability plan lost browser-use MCP registration: %v", command)
						}
					}

					if command[len(command)-1] != "-p" {
						t.Fatalf("Claude-family prompt ordering changed: %v", command)
					}
				})
			}
		}
	}
}

// TestClaudeFamilyRestrictedCapabilityPlansRemainDormant exercises the
// historical restricted encoders directly through the low-level driver builder.
// These plans are no longer reachable from any production entry point, but the
// encoders, capability composition, and credential/tool assertions are kept
// alive so a future regression in the dormant code is still caught.
func TestClaudeFamilyRestrictedCapabilityPlansRemainDormant(t *testing.T) {
	setupClaudeFamilyCapabilityPlans(t)
	for _, family := range []string{"claude", "codebuddy"} {
		for _, mode := range []catalog.PermissionMode{catalog.PermissionReadonly, catalog.PermissionEdit} {
			for _, pack := range []string{"mcp-only", "bash-only", "notesmd", "external-only", "browser-use"} {
				t.Run(family+"/"+string(mode)+"/"+pack, func(t *testing.T) {
					plan, err := buildDormantClaudeFamilyCapabilityPlan(t, family, pack, mode)
					if err != nil {
						if strings.Contains(err.Error(), "permission arguments were not found") {
							t.Fatalf("dormant capability finalization depended on pristine argv: %v", err)
						}
						t.Fatal(err)
					}
					tools := claudeToolsValue(plan.Command)
					if !strings.Contains(tools, "Read") || !strings.Contains(tools, "Bash") || !strings.Contains(tools, "WebSearch") {
						t.Fatalf("%s %s lost baseline tools: %q", family, mode, tools)
					}
					if mode == catalog.PermissionReadonly && (strings.Contains(tools, "Edit") || strings.Contains(tools, "Write") || strings.Contains(tools, "Agent")) {
						t.Fatalf("readonly capability weakened builtin scope: %q", tools)
					}
					if mode == catalog.PermissionEdit && (!strings.Contains(tools, "Edit") || !strings.Contains(tools, "Write") || strings.Contains(tools, "Agent")) {
						t.Fatalf("edit capability builtin scope mismatch: %q", tools)
					}
					disallowed := strings.Join(claudeFlagSection(plan.Command, "--disallowedTools"), ",")
					for _, denied := range []string{"Bash(*$*)", "EnterPlanMode", "Agent", "TeamCreate", "TeamDelete", "SendMessage"} {
						if !strings.Contains(disallowed, denied) {
							t.Fatalf("%s %s %s lost denial %q: %v", family, mode, pack, denied, plan.Command)
						}
					}

					switch pack {
					case "mcp-only":
						if !contains(plan.Command, "--strict-mcp-config") || !strings.Contains(argAfter(plan.Command, "--mcp-config"), `"capserver"`) {
							t.Fatalf("dormant MCP capability plan missing capserver: %v", plan.Command)
						}
					case "browser-use":
						if !contains(plan.Command, "--strict-mcp-config") || !strings.Contains(argAfter(plan.Command, "--mcp-config"), `"browser-use"`) {
							t.Fatalf("dormant embedded browser-use MCP plan missing browser-use server: %v", plan.Command)
						}
					case "bash-only", "notesmd":
						wantRule := "Bash(cap-reader *)"
						if pack == "notesmd" {
							wantRule = "Bash(notesmd-cli *)"
						}
						allowed := claudeFlagSection(plan.Command, "--allowedTools")
						if !contains(allowed, wantRule) || argIndex(plan.Command, wantRule) > argIndex(plan.Command, "--disallowedTools") {
							t.Fatalf("Bash capability was not composed before denials: %v", plan.Command)
						}
					case "external-only":
						if !strings.Contains(tools, "ExternalReader") {
							t.Fatalf("safe external tool missing from dormant plan: %v", plan.Command)
						}
					}
					if plan.Command[len(plan.Command)-1] != "-p" {
						t.Fatalf("Claude-family prompt ordering changed: %v", plan.Command)
					}
				})
			}
		}
	}
}

// buildDormantClaudeFamilyCapabilityPlan drives driver.BuildPlan directly with
// an explicit non-YOLO mode. It bypasses the production normalization in
// execution.Prepare/driver.BuildProductionPlan on purpose so the dormant
// restricted encoders stay covered.
func buildDormantClaudeFamilyCapabilityPlan(t *testing.T, family, pack string, mode catalog.PermissionMode) (driver.CommandPlan, error) {
	t.Helper()
	desc, err := catalog.DefaultRegistry().LookupDescriptor(family)
	if err != nil {
		t.Fatal(err)
	}
	return driver.BuildPlan(driver.PlanRequest{
		Spec: driver.ProfileSpec{
			Name: family + "-dormant-" + pack, Client: family,
			Launcher:     map[string]interface{}{"command": family},
			Env:          map[string]string{},
			ClientDesc:   desc,
			ForgeDataDir: t.TempDir(),
		},
		Prompt: "inspect dormant capability composition", WorkDir: t.TempDir(), Permission: mode,
		Capabilities: []string{pack}, ResolveCapabilities: resolveCapabilityPacks,
	})
}

func TestClaudeFamilyCompletePlansRejectBuiltinCapabilityCollisions(t *testing.T) {
	setupClaudeFamilyCapabilityPlans(t)
	cases := []struct {
		pack string
		mode catalog.PermissionMode
		id   string
	}{
		{pack: "collision-team", mode: catalog.PermissionEdit, id: "TeamCreate"},
		{pack: "collision-agent", mode: catalog.PermissionReadonly, id: "Agent"},
		{pack: "collision-edit", mode: catalog.PermissionReadonly, id: "Edit"},
		{pack: "collision-unencodable", mode: catalog.PermissionYolo, id: "EnterPlanMode"},
	}
	for _, profileName := range []string{"cc-glm", "cb-hy"} {
		for _, tc := range cases {
			t.Run(profileName+"/"+tc.pack, func(t *testing.T) {
				command, err := prepareClaudeFamilyCapabilityPlan(t, profileName, tc.pack, tc.mode)
				if err == nil || !strings.Contains(err.Error(), "collides with a client-owned builtin") || !strings.Contains(err.Error(), tc.id) {
					t.Fatalf("builtin collision %q error = %v", tc.id, err)
				}
				if len(command) == 0 || command[len(command)-1] != "-p" {
					t.Fatalf("collision error lost the complete family plan: %v", command)
				}
			})
		}
	}
}

func TestOpenCodeCompletePlansComposeEmbeddedNotesmdBashCapability(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	dataDir := t.TempDir()

	for _, mode := range []catalog.PermissionMode{catalog.PermissionReadonly, catalog.PermissionEdit} {
		t.Run(string(mode), func(t *testing.T) {
			baseBefore := catalog.PolicyFor(mode)
			plan, err := driver.BuildPlan(driver.PlanRequest{
				Spec: driver.ProfileSpec{
					Name: "opencode-notesmd", Client: "opencode",
					Launcher:     map[string]interface{}{"command": "opencode"},
					Env:          map[string]string{},
					ForgeDataDir: dataDir,
					ClientDesc: catalog.Client{
						Name: "opencode", Dialect: catalog.DialectOpenCode,
						PermissionAdapter: catalog.PermissionAdapterOpenCode,
					},
				},
				Prompt: "inspect notes", WorkDir: t.TempDir(), Permission: mode,
				Capabilities: []string{"notesmd"}, ResolveCapabilities: resolveCapabilityPacks,
			})
			if err != nil {
				t.Fatal(err)
			}
			if plan.ConfigDir == "" || plan.Env[bashgate.OpenCodeBashPermissionEnv] == "" {
				t.Fatalf("OpenCode notesmd plan did not materialize an isolated permission config: %+v", plan)
			}

			var bash map[string]string
			if err := json.Unmarshal([]byte(plan.Env[bashgate.OpenCodeBashPermissionEnv]), &bash); err != nil {
				t.Fatalf("decode OpenCode notesmd Bash rules: %v", err)
			}
			for pattern, decision := range map[string]string{
				"notesmd-cli *":   "allow",
				"pwd":             "allow",
				"Get-ChildItem *": "allow",
				"*":               "allow",
			} {
				if bash[pattern] != decision {
					t.Errorf("%s OpenCode notesmd Bash rule %q = %q, want %q", mode, pattern, bash[pattern], decision)
				}
			}

			baselineConfig, err := catalog.EncodeOpenCodeBashPermission(baseBefore)
			if err != nil {
				t.Fatal(err)
			}
			var actualBash, baselineBash map[string]interface{}
			if err := json.Unmarshal([]byte(plan.Env[bashgate.OpenCodeBashPermissionEnv]), &actualBash); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal([]byte(baselineConfig), &baselineBash); err != nil {
				t.Fatal(err)
			}
			delete(actualBash, "notesmd-cli *")
			if !reflect.DeepEqual(actualBash, baselineBash) {
				t.Fatalf("%s OpenCode notesmd plan did not retain the complete builtin restricted policy", mode)
			}
			if !reflect.DeepEqual(catalog.PolicyFor(mode), baseBefore) {
				t.Fatalf("%s OpenCode capability planning mutated the shared neutral policy", mode)
			}
		})
	}
}

func claudeToolsValue(args []string) string {
	for i := len(args) - 1; i >= 0; i-- {
		if strings.HasPrefix(args[i], "--tools=") {
			return strings.TrimPrefix(args[i], "--tools=")
		}
		if args[i] == "--tools" && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}

func claudeFlagSection(args []string, flag string) []string {
	for i := len(args) - 1; i >= 0; i-- {
		if args[i] != flag {
			continue
		}
		var values []string
		for _, arg := range args[i+1:] {
			if strings.HasPrefix(arg, "--") || arg == "-p" {
				break
			}
			values = append(values, arg)
		}
		return values
	}
	return nil
}
