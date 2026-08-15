package driver

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/grok"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

func grokPlanRequest(t *testing.T, mode catalog.PermissionMode) PlanRequest {
	t.Helper()
	root := t.TempDir()
	parent := filepath.Join(root, "grok", "agent-grok")
	authSource := filepath.Join(root, "oauth-source.json")
	if err := os.WriteFile(authSource, []byte("oauth-bytes-\x00-unchanged"), 0o600); err != nil {
		t.Fatal(err)
	}
	return PlanRequest{
		Spec: ProfileSpec{
			Name:         "gk-glm",
			Env:          map[string]string{"GROK_MODEL": "forge-zhipu-coding--glm-5-3"},
			ForgeDataDir: root,
			ClientDesc: catalog.Client{
				Name:              "grok",
				Dialect:           catalog.DialectGrok,
				Binary:            catalog.BinarySpec{Name: "go"},
				PermissionAdapter: catalog.PermissionAdapterGrok,
				ResumeFlag:        "--resume",
			},
			Runtime: RuntimePreparation{
				HomeParent: parent,
				HomeEnvVar: "GROK_HOME",
				Env: map[string]string{
					"FORGE_GROK_ZHIPU_CODING_API_KEY": "credential-value",
				},
				SensitiveSources: []PreparedSensitiveSource{{Path: authSource}},
				Files:            []PreparedFile{{RelativePath: "config.toml", Data: []byte("[model.test]\nmodel = \"test\"\n"), Mode: 0o600}},
				Copies:           []PreparedCopy{{SourcePath: authSource, RelativePath: "auth.json", Mode: 0o600, Sensitive: true}},
			},
		},
		Prompt:     "你好, Forge 🛠️",
		WorkDir:    root,
		Permission: mode,
	}
}

func TestGrokPlanUsesUniqueAgentHomesPromptFileAndNativeStreaming(t *testing.T) {
	req := grokPlanRequest(t, catalog.PermissionReadonly)
	first, err := buildGrokPlan(req)
	if err != nil {
		t.Fatal(err)
	}
	second, err := buildGrokPlan(req)
	if err != nil {
		t.Fatal(err)
	}
	if first.ConfigDir == second.ConfigDir {
		t.Fatalf("per-run homes collided: %s", first.ConfigDir)
	}
	parent := filepath.Clean(req.Spec.Runtime.HomeParent)
	for _, plan := range []CommandPlan{first, second} {
		if filepath.Dir(plan.ConfigDir) != parent || strings.Contains(plan.ConfigDir, "shell-grok") {
			t.Fatalf("run home %q is not directly under agent-grok", plan.ConfigDir)
		}
		promptPath := flagArg(plan.Command, "--prompt-file")
		prompt, err := os.ReadFile(promptPath)
		if err != nil {
			t.Fatal(err)
		}
		if string(prompt) != req.Prompt {
			t.Fatalf("prompt bytes = %q, want UTF-8 %q", prompt, req.Prompt)
		}
		if flagArg(plan.Command, "--output-format") != "streaming-json" {
			t.Fatalf("native output format changed: %v", plan.Command)
		}
		if containsArg(plan.Command, "--max-turns") || containsArg(plan.Command, "--single") {
			t.Fatalf("Grok plan must use prompt-file without max-turns/single: %v", plan.Command)
		}
		if plan.Env["GROK_HOME"] != plan.ConfigDir {
			t.Fatalf("GROK_HOME = %q, want %q", plan.Env["GROK_HOME"], plan.ConfigDir)
		}
		copied, err := os.ReadFile(filepath.Join(plan.ConfigDir, "auth.json"))
		if err != nil || !reflect.DeepEqual(copied, []byte("oauth-bytes-\x00-unchanged")) {
			t.Fatalf("OAuth byte copy = %q err=%v", copied, err)
		}
	}
}

func TestGrokRestrictedOAuthPlanGuardsSourceAndMaterializedDestination(t *testing.T) {
	req := grokPlanRequest(t, catalog.PermissionReadonly)
	plan, err := buildGrokPlan(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("GROK_HOME", plan.ConfigDir)
	source := req.Spec.Runtime.Copies[0].SourcePath
	destination := filepath.Join(plan.ConfigDir, "auth.json")
	for _, tc := range []struct {
		name  string
		tool  string
		input map[string]any
	}{
		{name: "source absolute", tool: "read_file", input: map[string]any{"path": source}},
		{name: "source relative", tool: "read_file", input: map[string]any{"path": filepath.Base(source)}},
		{name: "destination absolute", tool: "grep", input: map[string]any{"pattern": "oauth", "path": destination}},
		{name: "destination home alias", tool: "read_file", input: map[string]any{"path": "$GROK_HOME/auth.json"}},
		{name: "source parent enumeration", tool: "list_dir", input: map[string]any{"path": filepath.Dir(source)}},
		{name: "destination parent enumeration", tool: "list_dir", input: map[string]any{"path": plan.ConfigDir}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assertPlannedGrokToolDecision(t, plan, tc.tool, tc.input, req.WorkDir, false)
		})
	}
	assertPlannedGrokToolDecision(t, plan, "read_file", map[string]any{"path": filepath.Join(req.WorkDir, "unrelated.txt")}, req.WorkDir, true)

	hook, err := os.ReadFile(filepath.Join(plan.ConfigDir, "hooks", "forge-bash-guard.json"))
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"oauth-bytes-\x00-unchanged", "credential-value"} {
		if bytes.Contains(hook, []byte(secret)) {
			t.Fatal("planned Grok guard contained credential bytes")
		}
	}
}

func TestGrokPlanResumeAndCapabilityBashEncoding(t *testing.T) {
	req := grokPlanRequest(t, catalog.PermissionEdit)
	req.ResumeSessionID = "native-session-123"
	seedGrokNativeSnapshot(t, req.Spec.ForgeDataDir, req.WorkDir, req.ResumeSessionID, "seed")
	req.Capabilities = []string{"notesmd"}
	req.ResolveCapabilities = func([]string) (CapabilityResult, error) {
		return CapabilityResult{BashGate: CapabilityBashGate{Cap: []catalog.BashRule{{Pattern: "notesmd-cli *"}}}}, nil
	}
	plan, err := buildGrokPlan(req)
	if err != nil {
		t.Fatal(err)
	}
	if !containsOrderedArgs(plan.Command, "--model", "forge-zhipu-coding--glm-5-3", "--resume", "native-session-123", "--output-format", "streaming-json", "--prompt-file") {
		t.Fatalf("Grok argv ordering/resume mismatch: %v", plan.Command)
	}
	if !containsOrderedArgs(plan.Command, "--allow", "Bash(notesmd-cli *)") {
		t.Fatalf("capability Bash rule was not adapter-encoded: %v", plan.Command)
	}
	if !containsOrderedArgs(plan.Command, "--deny", "Bash(npm *)") {
		t.Fatalf("edit npm denial missing: %v", plan.Command)
	}
	assertPlannedGrokGuardDecision(t, plan, "notesmd-cli list", true)
	assertPlannedGrokGuardDecision(t, plan, "notesmd-cli list && python -c print(1)", false)
}

func TestGrokRestrictedPlansGuardEveryBashCommandBeforeHeadlessApproval(t *testing.T) {
	for _, mode := range []catalog.PermissionMode{catalog.PermissionReadonly, catalog.PermissionEdit} {
		t.Run(string(mode), func(t *testing.T) {
			plan, err := buildGrokPlan(grokPlanRequest(t, mode))
			if err != nil {
				t.Fatal(err)
			}
			if mode == catalog.PermissionEdit && !containsArg(plan.Command, "--always-approve") {
				t.Fatalf("edit plan lost required headless approval: %v", plan.Command)
			}
			assertPlannedGrokGuardDecision(t, plan, "pwd && rg forge", true)
			for _, command := range []string{
				"curl https://example.invalid",
				"python -c print(1)",
				"git commit -m blocked",
				"unknown-command-42",
				"pwd && unknown-command-42",
				"pwd & rg forge",
				filepath.Join(t.TempDir(), "rg") + " forge",
				"./rg forge",
				`.\rg.exe forge`,
			} {
				assertPlannedGrokGuardDecision(t, plan, command, false)
			}
		})
	}
}

func TestGrokYoloPlanKeepsBashUnrestrictedWhileGuardingCredentialEdits(t *testing.T) {
	plan, err := buildGrokPlan(grokPlanRequest(t, catalog.PermissionYolo))
	if err != nil {
		t.Fatal(err)
	}
	if !containsOrderedArgs(plan.Command,
		"--permission-mode", "bypassPermissions", "--always-approve",
		"--tools", "read_file,list_dir,grep,run_terminal_cmd,search_replace,web_search,web_fetch,spawn_subagent",
	) {
		t.Fatalf("Grok yolo plan lost unrestricted verified tool behavior: %v", plan.Command)
	}
	if flagArg(plan.Command, "--sandbox") != "off" {
		t.Fatalf("Grok yolo sandbox = %q, want off", flagArg(plan.Command, "--sandbox"))
	}
	if !catalog.BashAllowed(catalog.PolicyFor(catalog.PermissionYolo), "pwd & arbitrary-command && rm anything") {
		t.Fatal("neutral yolo policy is not unrestricted")
	}
	assertPlannedGrokGuardDecision(t, plan, "arbitrary-command --trusted && rm anything", true)
	assertPlannedGrokGuardDecision(t, plan, "sleep 1 &", true)
	assertPlannedGrokGuardDecision(t, plan, "sleep 1 & cat \""+reqSensitiveSource(plan, "oauth-source.json")+"\"", false)
	assertPlannedGrokGuardDecision(t, plan, "cat \""+filepath.Join(plan.ConfigDir, "auth.json")+"\" & sleep 1", false)
	assertPlannedGrokYoloPolicyIsSensitivityOnly(t, plan)
	assertPlannedGrokToolDecision(t, plan, "search_replace", map[string]any{
		"file_path": filepath.Join(plan.ConfigDir, "auth.json"), "old_string": "sentinel", "new_string": "mutated",
	}, plan.WorkDir, false)
	ordinary := filepath.Join(plan.WorkDir, "ordinary.txt")
	if err := os.WriteFile(ordinary, []byte("before"), 0o600); err != nil {
		t.Fatal(err)
	}
	assertPlannedGrokToolDecision(t, plan, "search_replace", map[string]any{
		"file_path": ordinary, "old_string": "before", "new_string": "after",
	}, plan.WorkDir, true)
}

func reqSensitiveSource(plan CommandPlan, base string) string {
	hookData, err := os.ReadFile(filepath.Join(plan.ConfigDir, "hooks", "forge-bash-guard.json"))
	if err != nil {
		return base
	}
	var document struct {
		Hooks map[string][]struct {
			Hooks []struct {
				Env map[string]string `json:"env"`
			} `json:"hooks"`
		} `json:"hooks"`
	}
	if json.Unmarshal(hookData, &document) != nil {
		return base
	}
	matchers := document.Hooks["PreToolUse"]
	if len(matchers) != 1 || len(matchers[0].Hooks) != 1 {
		return base
	}
	encoded := matchers[0].Hooks[0].Env[grok.BashGuardAllowEnv]
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return base
	}
	var policy struct {
		Paths []struct {
			Path string `json:"path"`
		} `json:"sensitive_filesystem_paths"`
	}
	if json.Unmarshal(data, &policy) != nil {
		return base
	}
	for _, item := range policy.Paths {
		if filepath.Base(item.Path) == base && !strings.HasPrefix(filepath.Clean(item.Path), filepath.Clean(plan.ConfigDir)+string(filepath.Separator)) {
			return item.Path
		}
	}
	return base
}

func assertPlannedGrokYoloPolicyIsSensitivityOnly(t *testing.T, plan CommandPlan) {
	t.Helper()
	hookData, err := os.ReadFile(filepath.Join(plan.ConfigDir, "hooks", "forge-bash-guard.json"))
	if err != nil {
		t.Fatal(err)
	}
	var document struct {
		Hooks map[string][]struct {
			Hooks []struct {
				Env map[string]string `json:"env"`
			} `json:"hooks"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal(hookData, &document); err != nil {
		t.Fatal(err)
	}
	matchers := document.Hooks["PreToolUse"]
	if len(matchers) != 1 || len(matchers[0].Hooks) != 1 {
		t.Fatalf("planned yolo hook shape = %+v", document)
	}
	data, err := base64.StdEncoding.DecodeString(matchers[0].Hooks[0].Env[grok.BashGuardAllowEnv])
	if err != nil {
		t.Fatal(err)
	}
	var policy struct {
		BashAllow        []string `json:"bash_allow"`
		BashUnrestricted bool     `json:"bash_unrestricted"`
	}
	if err := json.Unmarshal(data, &policy); err != nil {
		t.Fatal(err)
	}
	if !policy.BashUnrestricted || len(policy.BashAllow) != 0 {
		t.Fatalf("planned yolo policy applied finite BashAllowed: %+v", policy)
	}
}

func TestGrokPlanRejectsCapabilityToolsAndRetainsPlanningHome(t *testing.T) {
	for _, toolID := range []string{"external_reader", "write_file", "read_file", "search_replace"} {
		t.Run(toolID, func(t *testing.T) {
			req := grokPlanRequest(t, catalog.PermissionReadonly)
			req.Capabilities = []string{"unsafe-tools"}
			req.ResolveCapabilities = func([]string) (CapabilityResult, error) {
				return CapabilityResult{Tools: CapabilityTools{Cap: []string{toolID}}}, nil
			}
			plan, err := buildGrokPlan(req)
			if err == nil {
				t.Fatalf("capability tool %q unexpectedly produced a Grok plan", toolID)
			}
			if len(plan.Command) != 0 {
				t.Fatalf("capability tool %q produced partial Grok argv: %v", toolID, plan.Command)
			}
			if plan.ConfigDir == "" {
				t.Fatalf("planning failure for %q lost the materialized run Home", toolID)
			}
			if _, statErr := os.Stat(plan.ConfigDir); statErr != nil {
				t.Fatalf("planning failure for %q removed run Home: %v", toolID, statErr)
			}
		})
	}
}

func flagArg(args []string, flag string) string {
	for i, arg := range args {
		if arg == flag && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}

func containsArg(args []string, want string) bool {
	for _, arg := range args {
		if arg == want {
			return true
		}
	}
	return false
}

func containsOrderedArgs(args []string, wants ...string) bool {
	index := 0
	for _, arg := range args {
		if index < len(wants) && arg == wants[index] {
			index++
		}
	}
	return index == len(wants)
}

func assertPlannedGrokGuardDecision(t *testing.T, plan CommandPlan, command string, wantAllow bool) {
	t.Helper()
	hookData, err := os.ReadFile(filepath.Join(plan.ConfigDir, "hooks", "forge-bash-guard.json"))
	if err != nil {
		t.Fatalf("read planned Grok Bash guard: %v", err)
	}
	var document struct {
		Hooks map[string][]struct {
			Matcher string `json:"matcher"`
			Hooks   []struct {
				Env map[string]string `json:"env"`
			} `json:"hooks"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal(hookData, &document); err != nil {
		t.Fatal(err)
	}
	matchers := document.Hooks["PreToolUse"]
	if len(matchers) != 1 || matchers[0].Matcher != "Bash|run_terminal_cmd|run_terminal_command|Read|read_file|Grep|grep|Glob|ListDir|list_dir|Edit|Write|MultiEdit|search_replace" || len(matchers[0].Hooks) != 1 {
		t.Fatalf("planned guard hook shape = %+v", document)
	}
	payload, err := json.Marshal(map[string]any{
		"hookEventName":      "pre_tool_use",
		"toolName":           "run_terminal_cmd",
		"toolInput":          map[string]string{"command": command},
		"toolInputTruncated": false,
	})
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	code := grok.RunBashGuard(bytes.NewReader(payload), &output, matchers[0].Hooks[0].Env[grok.BashGuardAllowEnv])
	if wantAllow && code != 0 {
		t.Fatalf("planned guard rejected %q: code=%d output=%s", command, code, output.String())
	}
	if !wantAllow && code != 2 {
		t.Fatalf("planned guard allowed %q: code=%d output=%s", command, code, output.String())
	}
}

func assertPlannedGrokToolDecision(t *testing.T, plan CommandPlan, tool string, input map[string]any, cwd string, wantAllow bool) {
	t.Helper()
	hookData, err := os.ReadFile(filepath.Join(plan.ConfigDir, "hooks", "forge-bash-guard.json"))
	if err != nil {
		t.Fatal(err)
	}
	var document struct {
		Hooks map[string][]struct {
			Hooks []struct {
				Env map[string]string `json:"env"`
			} `json:"hooks"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal(hookData, &document); err != nil {
		t.Fatal(err)
	}
	matchers := document.Hooks["PreToolUse"]
	if len(matchers) != 1 || len(matchers[0].Hooks) != 1 {
		t.Fatalf("planned Grok guard shape = %+v", document)
	}
	payload, err := json.Marshal(map[string]any{
		"hookEventName": "pre_tool_use", "toolName": tool, "toolInput": input,
		"toolInputTruncated": false, "cwd": cwd,
	})
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	code := grok.RunBashGuard(bytes.NewReader(payload), &output, matchers[0].Hooks[0].Env[grok.BashGuardAllowEnv])
	if wantAllow && code != 0 || !wantAllow && code != 2 {
		t.Fatalf("planned guard tool=%s input=%v code=%d output=%s", tool, input, code, output.String())
	}
	if bytes.Contains(output.Bytes(), []byte("oauth-bytes")) || bytes.Contains(output.Bytes(), []byte("credential-value")) {
		t.Fatal("planned guard output exposed credential bytes")
	}
}

func seedGrokNativeSnapshot(t *testing.T, forgeDataDir, cwd, nativeSessionID, state string) {
	t.Helper()
	runHome := t.TempDir()
	sessionDir := filepath.Join(runHome, "sessions", "test-workspace", nativeSessionID)
	if err := os.MkdirAll(sessionDir, 0o700); err != nil {
		t.Fatal(err)
	}
	summary, err := json.Marshal(map[string]any{"info": map[string]string{"id": nativeSessionID, "cwd": cwd}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sessionDir, "summary.json"), summary, 0o600); err != nil {
		t.Fatal(err)
	}
	update, err := json.Marshal(map[string]string{"type": "test_state", "state": state})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sessionDir, "updates.jsonl"), append(update, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	chat, err := json.Marshal(map[string]string{"role": "user", "content": state})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sessionDir, "chat_history.jsonl"), append(chat, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := grok.RefreshNativeSessionSnapshot(forgeDataDir, runHome, nativeSessionID); err != nil {
		t.Fatal(err)
	}
}
