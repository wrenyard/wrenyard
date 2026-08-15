package driver

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/bashgate"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

// TestBuildClaudeCodePlanDirSideEffectOrdering asserts that, for a catalog-backed
// codebuddy PlanRequest, the persistent codebuddy/agent-config dir (created
// inside buildClaudeCodeEnv via ConfigIsolation.PersistentDir) and the common
// claude/direct-cc config/jobs dirs (created by ensureCCDirs) both exist before
// the binary resolution side effect fails. This pins the side-effect order:
// persistent config -> common CC dirs -> binary/model/command resolution.
func TestBuildClaudeCodePlanDirSideEffectOrdering(t *testing.T) {
	// Resolve the real codebuddy descriptor/provider behavior from the registry
	// so the test tracks the genuine catalog-backed path.
	desc, err := catalog.DefaultRegistry().LookupDescriptor("codebuddy")
	if err != nil {
		t.Fatalf("lookup codebuddy descriptor: %v", err)
	}
	provider, err := catalog.DefaultRegistry().LookupBinding("codebuddy")
	if err != nil {
		t.Fatalf("lookup codebuddy provider: %v", err)
	}

	// Force a guaranteed-missing binary so binary resolution is the only
	// expected failure, but only after the directory side effects run.
	desc.Binary = catalog.BinarySpec{
		Name:       "forge-definitely-missing-binary-xyz",
		WindowsCmd: "forge-definitely-missing-binary-xyz.cmd",
		NodeEntry:  "",
	}

	dir := t.TempDir()

	req := PlanRequest{
		Spec: ProfileSpec{
			Name:         "codebuddy",
			Client:       "codebuddy",
			ProviderName: "codebuddy",
			Env:          map[string]string{},
			UseCatalog:   true,
			ClientDesc:   desc,
			Provider:     provider,
			ForgeDataDir: dir,
		},
		Prompt:     "hello",
		WorkDir:    dir,
		Permission: catalog.PermissionEdit,
	}

	_, err = BuildPlan(req)
	if err == nil {
		t.Fatalf("expected BuildPlan to fail at binary resolution")
	}

	// Persistent codebuddy/agent-config dir must exist (created by
	// buildClaudeCodeEnv before binary resolution runs).
	persistentDir := filepath.Join(dir, "codebuddy", "agent-config")
	if _, statErr := os.Stat(persistentDir); statErr != nil {
		t.Errorf("persistent codebuddy config dir %q not created before binary resolution: %v", persistentDir, statErr)
	}

	// Common claude/direct-cc config/jobs dirs must exist (created by
	// ensureCCDirs before binary resolution runs).
	commonConfigDir := ClaudeConfigDir(dir)
	commonJobDir := ClaudeJobDir(dir)
	if _, statErr := os.Stat(commonConfigDir); statErr != nil {
		t.Errorf("common cc config dir %q not created before binary resolution: %v", commonConfigDir, statErr)
	}
	if _, statErr := os.Stat(commonJobDir); statErr != nil {
		t.Errorf("common cc job dir %q not created before binary resolution: %v", commonJobDir, statErr)
	}
}

// TestClaudeFamilyEditPlanGeneratesControlledBash asserts that, for both the
// claude and codebuddy descriptors, edit mode emits dontAsk-controlled Bash plus
// file-editing tools gated by the controlled-filesystem allow rules and the
// shell-metacharacter deny rules, while readonly and yolo remain distinct.
func TestClaudeFamilyEditPlanGeneratesControlledBash(t *testing.T) {
	for _, name := range []string{"claude", "codebuddy"} {
		desc, err := catalog.DefaultRegistry().LookupDescriptor(name)
		if err != nil {
			t.Fatalf("lookup %s descriptor: %v", name, err)
		}
		t.Run(name, func(t *testing.T) {
			editArgs := appendClaudeCodeOptions(nil, PlanRequest{Permission: catalog.PermissionEdit}, desc)

			// dontAsk controlled edit (not yolo/acceptEdits).
			if !argsContain(editArgs, "--permission-mode") || !argsContain(editArgs, "dontAsk") {
				t.Fatalf("edit should be dontAsk: %v", editArgs)
			}
			if argsContain(editArgs, "--dangerously-skip-permissions") || argsContain(editArgs, "acceptEdits") {
				t.Fatalf("edit must not be yolo/acceptEdits: %v", editArgs)
			}

			// Shared edit tools include Bash plus Edit and Write.
			for _, tool := range []string{"Read", "Bash", "Edit", "Write", "Glob", "Grep"} {
				if !hasTool(editArgs, tool) {
					t.Fatalf("edit tools missing %q: %v", tool, editArgs)
				}
			}
			allowed := effectiveDelimitedFlagValues(editArgs, "--allowedTools", "--allowed-tools")
			if len(allowed) < 2 || allowed[0] != "Edit" || allowed[1] != "Write" {
				t.Fatalf("edit command must pre-authorize exact Edit and Write rules before Bash rules: %v", allowed)
			}

			// Controlled filesystem Bash allow rules expose only the new gated
			// single-path deletion surface; the old broad rm-family rules are gone.
			for _, rule := range []string{
				"Bash(git rm -- *)", "Bash(mkdir *)", "Bash(cp *)", "Bash(mv *)",
				"Bash(touch *)", "Bash(chmod *)", "Bash(ln *)",
			} {
				if !hasBashRule(editArgs, rule) {
					t.Fatalf("edit command missing Bash allow rule %q: %v", rule, editArgs)
				}
			}
			for _, rule := range []string{
				"Bash(rm *)", "Bash(del *)", "Bash(erase *)", "Bash(rmdir *)", "Bash(rd *)",
			} {
				if hasBashRule(editArgs, rule) {
					t.Fatalf("edit command must not expose broad deletion rule %q: %v", rule, editArgs)
				}
			}
			// Shell-metacharacter deny rules.
			for _, rule := range []string{"Bash(*$*)"} {
				if !hasBashRule(editArgs, rule) {
					t.Fatalf("edit command missing Bash deny rule %q: %v", rule, editArgs)
				}
			}

			// readonly and yolo remain distinct from edit.
			roArgs := appendClaudeCodeOptions(nil, PlanRequest{Permission: catalog.PermissionReadonly}, desc)
			if hasTool(roArgs, "Edit") || hasTool(roArgs, "Write") {
				t.Fatalf("readonly must not include Edit/Write: %v", roArgs)
			}
			yoloArgs := appendClaudeCodeOptions(nil, PlanRequest{Permission: catalog.PermissionYolo}, desc)
			if argsContain(yoloArgs, "dontAsk") || hasBashRule(yoloArgs, "Bash(git rm -- *)") {
				t.Fatalf("yolo must not carry edit controls: %v", yoloArgs)
			}
			if name == "claude" && !argsContain(yoloArgs, "--dangerously-skip-permissions") {
				t.Fatalf("claude yolo flag missing: %v", yoloArgs)
			}
			if name == "codebuddy" && !argsContain(yoloArgs, "-y") {
				t.Fatalf("codebuddy yolo flag missing: %v", yoloArgs)
			}
		})
	}
}

func TestClaudeFamilyProductionPlansInstallIsolatedSegmentAwareBashGate(t *testing.T) {
	for _, clientName := range []string{"claude", "codebuddy"} {
		t.Run(clientName, func(t *testing.T) {
			desc, err := catalog.DefaultRegistry().LookupDescriptor(clientName)
			if err != nil {
				t.Fatal(err)
			}
			req := PlanRequest{
				Spec: ProfileSpec{
					Name: clientName, Client: clientName, ClientDesc: desc,
					ForgeDataDir: t.TempDir(), Launcher: map[string]interface{}{"command": "go"},
					Settings: map[string]interface{}{"modelOverrides": map[string]interface{}{"opus": "preserved-model"}},
				},
				Prompt: "inspect safely", WorkDir: t.TempDir(), Permission: catalog.PermissionReadonly,
				Capabilities: []string{"notesmd"}, ResolveCapabilities: func([]string) (CapabilityResult, error) {
					return CapabilityResult{BashGate: CapabilityBashGate{Cap: []catalog.BashRule{{Pattern: "notesmd-cli *"}}}}, nil
				},
			}
			plan, err := BuildPlan(req)
			if err != nil {
				t.Fatal(err)
			}
			settingsJSON := flagArg(plan.Command, "--settings")
			if settingsJSON == "" || strings.Count(strings.Join(plan.Command, "\n"), "--settings") != 1 {
				t.Fatalf("isolated inline settings argv = %v", plan.Command)
			}
			var settings struct {
				ModelOverrides map[string]string `json:"modelOverrides"`
				Hooks          map[string][]struct {
					Matcher string `json:"matcher"`
					Hooks   []struct {
						Type    string `json:"type"`
						Command string `json:"command"`
						Timeout int    `json:"timeout"`
					} `json:"hooks"`
				} `json:"hooks"`
			}
			if err := json.Unmarshal([]byte(settingsJSON), &settings); err != nil {
				t.Fatal(err)
			}
			matchers := settings.Hooks["PreToolUse"]
			if len(matchers) != 1 || matchers[0].Matcher != "^Bash$" || len(matchers[0].Hooks) != 1 ||
				matchers[0].Hooks[0].Type != "command" || matchers[0].Hooks[0].Command == "" || matchers[0].Hooks[0].Timeout <= 0 {
				t.Fatalf("Claude-family hook contract = %+v", settings.Hooks)
			}
			hookCommand := matchers[0].Hooks[0].Command
			if runtime.GOOS == "windows" {
				hookCommand = strings.TrimSpace(hookCommand)
				executableToken := "%" + bashgate.ExecutableEnv + "%"
				if !strings.Contains(hookCommand, executableToken) || !strings.Contains(hookCommand, "cmd.exe /d /s /c") {
					t.Fatalf("Windows Claude-family adapter: command=%q env=%q", hookCommand, plan.Env[bashgate.ExecutableEnv])
				}
				executable := strings.Trim(plan.Env[bashgate.ExecutableEnv], `"`)
				if executable == "" {
					t.Fatalf("Windows Claude-family adapter missing executable env: %#v", plan.Env)
				}
			} else if plan.Env[bashgate.ExecutableEnv] != "" {
				t.Fatalf("non-Windows Claude-family plan gained Windows adapter env: %#v", plan.Env)
			}
			if clientName == "codebuddy" && settings.ModelOverrides["opus"] != "preserved-model" {
				t.Fatalf("CodeBuddy settings merge lost modelOverrides: %+v", settings)
			}
			client := bashgate.ClientClaude
			if clientName == "codebuddy" {
				client = bashgate.ClientCodeBuddy
			}
			if plan.Env[bashgate.ModeEnv] != string(client) || plan.Env[bashgate.PolicyEnv] == "" {
				t.Fatalf("per-run BashGate env = %#v", plan.Env)
			}
			for _, decision := range []struct {
				command string
				allow   bool
			}{
				{command: "cat harmless | head -n 1", allow: true},
				{command: "notesmd-cli list && cat README.md", allow: true},
				{command: "cat harmless ; rm victim"},
				{command: "cat harmless | tee victim"},
				{command: "cat harmless & head harmless"},
				{command: "cat harmless\r\nhead harmless", allow: true},
			} {
				payload, _ := json.Marshal(map[string]any{
					"hook_event_name": "PreToolUse", "tool_name": "Bash",
					"tool_input": map[string]string{"command": decision.command},
				})
				var output bytes.Buffer
				code := bashgate.Run(bytes.NewReader(payload), &output, plan.Env[bashgate.ModeEnv], plan.Env[bashgate.PolicyEnv])
				if decision.allow && code != 0 || !decision.allow && code != 2 {
					t.Fatalf("planned BashGate(%q) code=%d output=%s", decision.command, code, output.String())
				}
			}
		})
	}
}

func TestClaudeFamilyYoloRetainsDocumentedUnrestrictedBoundary(t *testing.T) {
	for _, clientName := range []string{"claude", "codebuddy"} {
		t.Run(clientName, func(t *testing.T) {
			desc, err := catalog.DefaultRegistry().LookupDescriptor(clientName)
			if err != nil {
				t.Fatal(err)
			}
			plan, err := BuildPlan(PlanRequest{
				Spec:   ProfileSpec{Name: clientName, Client: clientName, ClientDesc: desc, ForgeDataDir: t.TempDir(), Launcher: map[string]interface{}{"command": "go"}},
				Prompt: "unrestricted", WorkDir: t.TempDir(), Permission: catalog.PermissionYolo,
			})
			if err != nil {
				t.Fatal(err)
			}
			if !catalog.BashAllowed(catalog.PolicyFor(catalog.PermissionYolo), "cat harmless ; arbitrary-command & rm victim") {
				t.Fatal("yolo policy lost its explicit unrestricted trust boundary")
			}
			if clientName == "claude" && !argsContain(plan.Command, "--dangerously-skip-permissions") || clientName == "codebuddy" && !argsContain(plan.Command, "-y") {
				t.Fatalf("yolo production argv = %v", plan.Command)
			}
			if plan.Env[bashgate.ModeEnv] != "" || flagArg(plan.Command, "--settings") != "" {
				t.Fatalf("yolo unexpectedly retained restricted hook configuration: argv=%v env=%#v", plan.Command, plan.Env)
			}
		})
	}
}
