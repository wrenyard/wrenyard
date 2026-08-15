package driver

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/bashgate"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

func TestOpenCodeResumePlanUsesNativeSessionFlag(t *testing.T) {
	plan, err := BuildPlan(PlanRequest{
		Spec: ProfileSpec{
			Name: "opencode-test", Client: "opencode", ForgeDataDir: t.TempDir(),
			Launcher: map[string]interface{}{"command": "opencode"},
			ClientDesc: catalog.Client{
				Name: "opencode", Dialect: catalog.DialectOpenCode,
				PermissionAdapter: catalog.PermissionAdapterOpenCode,
			},
		},
		Prompt: "continue", WorkDir: t.TempDir(), Permission: catalog.PermissionReadonly,
		ResumeSessionID: "ses_opencode_1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !containsFlagPair(plan.Command, "--session", "ses_opencode_1") {
		t.Fatalf("OpenCode resume command missing native session flag: %v", plan.Command)
	}
}

func TestCompleteOpenCodePlansEncodeDistinctFailClosedPermissions(t *testing.T) {
	dataDir := t.TempDir()
	sharedConfig := filepath.Join(t.TempDir(), "opencode.json")
	sharedSentinel := []byte(`{"permission":"allow"}`)
	if err := os.WriteFile(sharedConfig, sharedSentinel, 0o600); err != nil {
		t.Fatal(err)
	}

	wants := []struct {
		mode         catalog.PermissionMode
		edit         bool
		agent        bool
		unrestricted bool
		gitRMAllow   bool
	}{
		{mode: catalog.PermissionReadonly},
		{mode: catalog.PermissionEdit, edit: true, gitRMAllow: true},
		{mode: catalog.PermissionYolo, edit: true, agent: true, unrestricted: true, gitRMAllow: true},
	}
	seenHomes := map[string]bool{}
	for _, want := range wants {
		t.Run(string(want.mode), func(t *testing.T) {
			plan, err := BuildPlan(PlanRequest{
				Spec: ProfileSpec{
					Name: "opencode-test", Client: "opencode",
					Launcher: map[string]interface{}{"command": "opencode"},
					Env: map[string]string{
						"OPENCODE_MODEL":      "openai/gpt-test",
						"OPENCODE_PERMISSION": "allow",
					},
					ForgeDataDir: dataDir,
					ClientDesc: catalog.Client{
						Name: "opencode", Dialect: catalog.DialectOpenCode,
						PermissionAdapter: catalog.PermissionAdapterOpenCode,
					},
				},
				Prompt: "inspect", WorkDir: t.TempDir(), Permission: want.mode,
			})
			if err != nil {
				t.Fatal(err)
			}
			if seenHomes[plan.ConfigDir] || plan.ConfigDir == "" || plan.Env["XDG_CONFIG_HOME"] != plan.ConfigDir || plan.Env["OPENCODE_CONFIG_DIR"] != plan.ConfigDir {
				t.Fatalf("OpenCode per-run config isolation = dir %q env %#v", plan.ConfigDir, plan.Env)
			}
			if plan.Env["OPENCODE_CONFIG"] != filepath.Join(plan.ConfigDir, "opencode.json") {
				t.Fatalf("OpenCode isolated base config path = %q", plan.Env["OPENCODE_CONFIG"])
			}
			base, err := os.ReadFile(plan.Env["OPENCODE_CONFIG"])
			if err != nil {
				t.Fatalf("read OpenCode isolated base config: %v", err)
			}
			seenHomes[plan.ConfigDir] = true
			if len(plan.Resources) != 1 || !plan.Resources[0].RemoveOnSuccess || plan.Resources[0].RemoveOnCompletion || plan.Resources[0].Path != plan.ConfigDir {
				t.Fatalf("OpenCode cleanup resource = %+v", plan.Resources)
			}
			if plan.Env["OPENCODE_DISABLE_PROJECT_CONFIG"] != "true" || plan.Env["OPENCODE_DISABLE_CLAUDE_CODE"] != "true" {
				t.Fatalf("OpenCode external config isolation missing: %#v", plan.Env)
			}
			if _, ok := plan.Env["OPENCODE_PERMISSION"]; ok {
				t.Fatalf("OpenCode legacy permission override survived planning: %#v", plan.Env)
			}

			var bootstrap struct {
				Permission map[string]interface{} `json:"permission"`
			}
			if err := json.Unmarshal(base, &bootstrap); err != nil {
				t.Fatalf("decode OpenCode bootstrap permission config: %v", err)
			}
			if bootstrap.Permission["*"] != "deny" {
				t.Fatalf("unknown OpenCode tools must fail closed: %#v", bootstrap.Permission)
			}
			for _, id := range []string{"read", "glob", "grep", "webfetch", "websearch"} {
				if bootstrap.Permission[id] != "allow" {
					t.Fatalf("%s missing %s permission: %#v", want.mode, id, bootstrap.Permission)
				}
			}
			if (bootstrap.Permission["edit"] == "allow" && bootstrap.Permission["write"] == "allow") != want.edit {
				t.Fatalf("%s Edit permission mismatch: %#v", want.mode, bootstrap.Permission)
			}
			if (bootstrap.Permission["task"] == "allow") != want.agent {
				t.Fatalf("%s Agent permission mismatch: %#v", want.mode, bootstrap.Permission)
			}
			bash, ok := bootstrap.Permission["bash"].(map[string]interface{})
			if !ok {
				t.Fatalf("%s Bash permission is not a rule map: %#v", want.mode, bootstrap.Permission["bash"])
			}
			if (bash["*"] == "allow") != want.unrestricted {
				t.Fatalf("%s Bash wildcard mismatch: %#v", want.mode, bash)
			}
			if !want.unrestricted {
				if len(bash) != 1 || bash["*"] != "deny" {
					t.Fatalf("%s bootstrap Bash permission is not fail closed: %#v", want.mode, bash)
				}
				var registration struct {
					Plugin []string `json:"plugin"`
				}
				if err := json.Unmarshal([]byte(plan.Env["OPENCODE_CONFIG_CONTENT"]), &registration); err != nil || len(registration.Plugin) != 1 {
					t.Fatalf("%s OpenCode plugin registration = %+v err=%v", want.mode, registration, err)
				}
				pluginPath := filepath.Join(plan.ConfigDir, "forge-bashgate.js")
				pluginURL, err := openCodeFileURL(pluginPath)
				if err != nil || registration.Plugin[0] != pluginURL {
					t.Fatalf("%s OpenCode plugin registration = %q want %q err=%v", want.mode, registration.Plugin, pluginURL, err)
				}
				pluginBytes, err := os.ReadFile(pluginPath)
				if err != nil || string(pluginBytes) != string(bashgate.OpenCodePluginBytes()) || !strings.Contains(string(pluginBytes), `"tool.execute.before"`) {
					t.Fatalf("%s materialized OpenCode plugin mismatch: err=%v", want.mode, err)
				}
				if plan.Env[bashgate.ModeEnv] != string(bashgate.ClientOpenCode) || plan.Env[bashgate.PolicyEnv] == "" || plan.Env[bashgate.OpenCodeExecutableEnv] == "" {
					t.Fatalf("%s OpenCode BashGate env missing: %#v", want.mode, plan.Env)
				}
				activeConfig := `{"permission":{"bash":` + plan.Env[bashgate.OpenCodeBashPermissionEnv] + `}}`
				for _, command := range []string{"pwd && rg forge", "pwd ; rg forge", "cat go.mod | head -n 1"} {
					if !openCodePlanBashAllows(t, activeConfig, command) {
						t.Errorf("%s active native config rejected gated safe chain %q", want.mode, command)
					}
				}
				for _, removed := range []string{"*&&*", "*||*", "*;*", "*|*", "*\r*", "*\n*"} {
					if _, present := bash[removed]; present {
						t.Errorf("%s bootstrap retained blanket separator rule %q", want.mode, removed)
					}
				}
				if containsArg(plan.Command, "--pure") {
					t.Fatalf("%s restricted OpenCode argv disabled its required plugin: %v", want.mode, plan.Command)
				}
			} else {
				if plan.Env["OPENCODE_CONFIG_CONTENT"] != "{}" || plan.Env[bashgate.ModeEnv] != "" || plan.Env[bashgate.PolicyEnv] != "" || plan.Env[bashgate.OpenCodeBashPermissionEnv] != "" {
					t.Fatalf("yolo unexpectedly retained OpenCode BashGate: %#v", plan.Env)
				}
				if _, err := os.Stat(filepath.Join(plan.ConfigDir, "forge-bashgate.js")); !os.IsNotExist(err) {
					t.Fatalf("yolo materialized restricted OpenCode plugin: %v", err)
				}
				if !containsArg(plan.Command, "--pure") {
					t.Fatalf("yolo OpenCode argv lost pure compatibility: %v", plan.Command)
				}
			}

			separatorCommands := []string{
				"ls & rm marker",
				"ls\rrm marker",
				"ls\nrm marker",
				"ls\r\nrm marker",
				"ls\n\rrm marker",
			}
			for _, command := range separatorCommands {
				if got := openCodePlanBashAllows(t, string(base), command); got != want.unrestricted {
					t.Errorf("%s separator command decision for %q = %v, want %v", want.mode, command, got, want.unrestricted)
				}
			}
			for _, command := range []string{"pwd", "ls -la", "Get-ChildItem -Name"} {
				activeConfig := string(base)
				if !want.unrestricted {
					activeConfig = `{"permission":{"bash":` + plan.Env[bashgate.OpenCodeBashPermissionEnv] + `}}`
				}
				if !openCodePlanBashAllows(t, activeConfig, command) {
					t.Errorf("%s generated config rejected safe single command %q", want.mode, command)
				}
			}
			if !want.unrestricted {
				for _, command := range []string{"rm marker", "git rm -- marker"} {
					payload, _ := json.Marshal(map[string]any{
						"hook_event_name": "PreToolUse", "tool_name": "bash",
						"tool_input": map[string]string{"command": command},
					})
					var output strings.Builder
					code := bashgate.Run(strings.NewReader(string(payload)), &output, plan.Env[bashgate.ModeEnv], plan.Env[bashgate.PolicyEnv])
					wantDecision := command == "git rm -- marker" && want.gitRMAllow
					if (code == 0) != wantDecision {
						t.Errorf("%s BashGate deletion decision for %q = code %d output %s", want.mode, command, code, output.String())
					}
				}
			}
		})
	}

	unchanged, err := os.ReadFile(sharedConfig)
	if err != nil || string(unchanged) != string(sharedSentinel) {
		t.Fatalf("shared OpenCode config changed: %q err=%v", unchanged, err)
	}
}

func TestCompleteOpenCodePlansRejectUnsupportedCapabilityToolsAndMCP(t *testing.T) {
	cases := []struct {
		name   string
		result CapabilityResult
	}{
		{name: "tools", result: CapabilityResult{Tools: CapabilityTools{Cap: []string{"ExternalReader"}}}},
		{name: "mcp", result: CapabilityResult{Tools: CapabilityTools{MCP: []CapabilityServer{{Name: "server", Command: "server"}}}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dataDir := t.TempDir()
			plan, err := BuildPlan(PlanRequest{
				Spec: ProfileSpec{
					Name: "opencode-test", Client: "opencode",
					Launcher:     map[string]interface{}{"command": "opencode"},
					Env:          map[string]string{},
					ForgeDataDir: dataDir,
					ClientDesc: catalog.Client{
						Name: "opencode", Dialect: catalog.DialectOpenCode,
						PermissionAdapter: catalog.PermissionAdapterOpenCode,
					},
				},
				Prompt: "inspect", WorkDir: t.TempDir(), Permission: catalog.PermissionReadonly,
				Capabilities: []string{"unsupported"},
				ResolveCapabilities: func([]string) (CapabilityResult, error) {
					return tc.result, nil
				},
			})
			if err == nil || !strings.Contains(err.Error(), "cannot safely encode capability tool or MCP contributions") {
				t.Fatalf("unsupported OpenCode %s contribution error = %v", tc.name, err)
			}
			if plan.ConfigDir != "" || len(plan.Resources) != 0 {
				t.Fatalf("unsupported OpenCode %s contribution materialized launch resources: %+v", tc.name, plan)
			}
			if _, statErr := os.Stat(filepath.Join(dataDir, "opencode", "direct-runs")); !os.IsNotExist(statErr) {
				t.Fatalf("unsupported OpenCode %s contribution reached runtime materialization: %v", tc.name, statErr)
			}
		})
	}
}

func openCodePlanBashAllows(t *testing.T, config, command string) bool {
	t.Helper()
	var document struct {
		Permission map[string]json.RawMessage `json:"permission"`
	}
	if err := json.Unmarshal([]byte(config), &document); err != nil {
		t.Fatalf("decode OpenCode permission config: %v", err)
	}
	decoder := json.NewDecoder(strings.NewReader(string(document.Permission["bash"])))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		t.Fatalf("decode OpenCode Bash rules: token=%v err=%v", token, err)
	}
	decision := ""
	for decoder.More() {
		key, err := decoder.Token()
		if err != nil {
			t.Fatalf("decode OpenCode Bash rule key: %v", err)
		}
		var value string
		if err := decoder.Decode(&value); err != nil {
			t.Fatalf("decode OpenCode Bash rule value: %v", err)
		}
		if openCodeWildcardMatch(key.(string), command) {
			decision = value
		}
	}
	return decision == "allow"
}

func openCodeWildcardMatch(pattern, value string) bool {
	patternIndex, valueIndex := 0, 0
	starIndex, starValueIndex := -1, -1
	for valueIndex < len(value) {
		switch {
		case patternIndex < len(pattern) && pattern[patternIndex] == value[valueIndex]:
			patternIndex++
			valueIndex++
		case patternIndex < len(pattern) && pattern[patternIndex] == '*':
			starIndex = patternIndex
			starValueIndex = valueIndex
			patternIndex++
		case starIndex >= 0:
			patternIndex = starIndex + 1
			starValueIndex++
			valueIndex = starValueIndex
		default:
			return false
		}
	}
	for patternIndex < len(pattern) && pattern[patternIndex] == '*' {
		patternIndex++
	}
	return patternIndex == len(pattern)
}
