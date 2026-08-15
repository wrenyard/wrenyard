package driver

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/bashgate"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

func TestCodexRestrictedPlansDisableNativeExecutionAndRegisterExactRequiredMCP(t *testing.T) {
	for _, mode := range []catalog.PermissionMode{catalog.PermissionReadonly, catalog.PermissionEdit} {
		for _, resume := range []bool{false, true} {
			name := string(mode) + "/run"
			if resume {
				name = string(mode) + "/resume"
			}
			t.Run(name, func(t *testing.T) {
				req := codexPlanRequest(t, mode)
				if resume {
					req.ResumeSessionID = "thread-codex-test"
				}
				plan, err := BuildPlan(req)
				if err != nil {
					t.Fatal(err)
				}
				if !containsFlag(plan.Command, "--strict-config") || !containsFlag(plan.Command, "--ignore-user-config") || !containsFlag(plan.Command, "--search") {
					t.Fatalf("restricted config isolation/search flags = %v", plan.Command)
				}
				for _, config := range []string{"features.shell_tool=false", "features.multi_agent=false"} {
					if !containsFlagPair(plan.Command, "-c", config) {
						t.Fatalf("restricted feature %q missing: %v", config, plan.Command)
					}
				}
				if resume {
					if !containsFlagPair(plan.Command, "-c", `sandbox_mode="`+catalog.PolicyFor(mode).CodexSandbox+`"`) {
						t.Fatalf("resume sandbox missing: %v", plan.Command)
					}
				} else if !containsFlagPair(plan.Command, "--sandbox", catalog.PolicyFor(mode).CodexSandbox) {
					t.Fatalf("run sandbox missing: %v", plan.Command)
				}
				assertExactCodexMCPRegistration(t, plan)
			})
		}
	}
}

func TestCodexYoloPreservesNativeUnrestrictedShellAndAgentWithoutForgeMCP(t *testing.T) {
	for _, resume := range []bool{false, true} {
		req := codexPlanRequest(t, catalog.PermissionYolo)
		if resume {
			req.ResumeSessionID = "thread-codex-yolo"
		}
		plan, err := BuildPlan(req)
		if err != nil {
			t.Fatal(err)
		}
		for _, config := range []string{"features.shell_tool=true", "features.multi_agent=true"} {
			if !containsFlagPair(plan.Command, "-c", config) {
				t.Fatalf("yolo feature %q missing: %v", config, plan.Command)
			}
		}
		if !containsFlag(plan.Command, "--dangerously-bypass-approvals-and-sandbox") {
			t.Fatalf("yolo bypass missing: %v", plan.Command)
		}
		if resume {
			if !containsFlagPair(plan.Command, "-c", `sandbox_mode="danger-full-access"`) {
				t.Fatalf("yolo resume sandbox missing: %v", plan.Command)
			}
		} else if !containsFlagPair(plan.Command, "--sandbox", "danger-full-access") {
			t.Fatalf("yolo run sandbox missing: %v", plan.Command)
		}
		if countConfigPrefix(plan.Command, "mcp_servers."+CodexMCPServerName+".") != 0 || len(plan.Resources) != 0 || plan.ConfigDir != "" {
			t.Fatalf("yolo retained restricted MCP state: command=%v resources=%+v config=%q", plan.Command, plan.Resources, plan.ConfigDir)
		}
	}
}

func TestCodexRestrictedPlanUsesExactEffectiveBashAllowAndProtectsAuth(t *testing.T) {
	req := codexPlanRequest(t, catalog.PermissionReadonly)
	authPath := filepath.Join(t.TempDir(), "auth.json")
	if err := os.WriteFile(authPath, []byte(`{"tokens":{"access_token":"credential-sentinel"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	req.Spec.Runtime.SensitiveSources = []PreparedSensitiveSource{{Path: authPath}}
	req.Capabilities = []string{"notesmd"}
	req.ResolveCapabilities = func([]string) (CapabilityResult, error) {
		return CapabilityResult{BashGate: CapabilityBashGate{Cap: []catalog.BashRule{{Pattern: "notesmd-cli *"}}}}, nil
	}
	plan, err := BuildPlan(req)
	if err != nil {
		t.Fatal(err)
	}
	policyPath := codexMCPPolicyPathFromPlan(t, plan)
	encoded, err := os.ReadFile(policyPath)
	if err != nil {
		t.Fatal(err)
	}
	policy := strings.TrimSpace(string(encoded))
	for _, command := range []string{"pwd; rg forge", "notesmd-cli list"} {
		if reason, ok := bashgate.AuthorizeCommand(bashgate.ClientCodex, policy, command, req.WorkDir); !ok {
			t.Fatalf("EffectiveBashAllow denied %q: %s", command, reason)
		}
	}
	for _, command := range []string{"pwd; echo unsafe", "cat " + authPath} {
		if _, ok := bashgate.AuthorizeCommand(bashgate.ClientCodex, policy, command, req.WorkDir); ok {
			t.Fatalf("restricted Codex policy allowed %q", command)
		}
	}
	if bytes, err := os.ReadFile(policyPath); err != nil || strings.Contains(string(bytes), "credential-sentinel") {
		t.Fatalf("policy leaked credential material: err=%v", err)
	}
}

func TestCodexPlanCLIConfigDoesNotMutateUserOrProjectConfig(t *testing.T) {
	home := t.TempDir()
	project := t.TempDir()
	userConfig := filepath.Join(home, "config.toml")
	projectConfig := filepath.Join(project, ".codex", "config.toml")
	if err := os.MkdirAll(filepath.Dir(projectConfig), 0o700); err != nil {
		t.Fatal(err)
	}
	userBytes := []byte("user_owned = true\n")
	projectBytes := []byte("project_owned = true\n")
	if err := os.WriteFile(userConfig, userBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(projectConfig, projectBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	req := codexPlanRequest(t, catalog.PermissionReadonly)
	req.WorkDir = project
	plan, err := BuildPlan(req)
	if err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string][]byte{userConfig: userBytes, projectConfig: projectBytes} {
		got, err := os.ReadFile(path)
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Fatalf("config %s changed: got=%q want=%q err=%v", path, got, want, err)
		}
	}
	if !containsFlag(plan.Command, "--ignore-user-config") || countConfigPrefix(plan.Command, "mcp_servers."+CodexMCPServerName+".") != 6 {
		t.Fatalf("isolated CLI config = %v", plan.Command)
	}
}

func codexPlanRequest(t *testing.T, mode catalog.PermissionMode) PlanRequest {
	t.Helper()
	desc, err := catalog.DefaultRegistry().LookupDescriptor("codex")
	if err != nil {
		t.Fatal(err)
	}
	return PlanRequest{
		Spec: ProfileSpec{
			Name: "codex-test", Client: "codex", ClientDesc: desc,
			Env:          map[string]string{"CODEX_MODEL": "gpt-test", "CODEX_REASONING_EFFORT": "high"},
			ForgeDataDir: t.TempDir(),
		},
		Prompt: "exercise Codex plan", WorkDir: t.TempDir(), Permission: mode,
	}
}

func assertExactCodexMCPRegistration(t *testing.T, plan CommandPlan) {
	t.Helper()
	prefix := "mcp_servers." + CodexMCPServerName
	if got := countConfigPrefix(plan.Command, prefix+"."); got != 6 {
		t.Fatalf("Forge MCP config count=%d want 6: %v", got, plan.Command)
	}
	if !containsFlagPair(plan.Command, "-c", prefix+`.cwd=`+tomlLiteral(plan.WorkDir)) ||
		!containsFlagPair(plan.Command, "-c", prefix+`.required=true`) ||
		!containsFlagPair(plan.Command, "-c", prefix+`.enabled_tools=["`+CodexMCPToolName+`"]`) ||
		!containsFlagPair(plan.Command, "-c", prefix+`.default_tools_approval_mode="approve"`) {
		t.Fatalf("Forge MCP registration mismatch: %v", plan.Command)
	}
	if len(plan.Resources) != 1 || !plan.Resources[0].RemoveOnSuccess || plan.Resources[0].RemoveOnCompletion || plan.Resources[0].Path != plan.ConfigDir {
		t.Fatalf("Forge MCP resource = %+v config=%q", plan.Resources, plan.ConfigDir)
	}
	policyPath := codexMCPPolicyPathFromPlan(t, plan)
	info, err := os.Stat(policyPath)
	if err != nil || !info.Mode().IsRegular() {
		t.Fatalf("policy resource missing: %v", err)
	}
	argsValue := configValue(t, plan.Command, prefix+".args=")
	var args []string
	if err := json.Unmarshal([]byte(argsValue), &args); err != nil || !reflect.DeepEqual(args, []string{CodexMCPSubcommand, "--policy", policyPath}) {
		t.Fatalf("Forge MCP args=%v err=%v raw=%q", args, err, argsValue)
	}
	commandValue := configValue(t, plan.Command, prefix+".command=")
	var executable string
	if err := json.Unmarshal([]byte(commandValue), &executable); err != nil || strings.TrimSpace(executable) == "" {
		t.Fatalf("Forge MCP command=%q err=%v", commandValue, err)
	}
}

func codexMCPPolicyPathFromPlan(t *testing.T, plan CommandPlan) string {
	t.Helper()
	argsValue := configValue(t, plan.Command, "mcp_servers."+CodexMCPServerName+".args=")
	var args []string
	if err := json.Unmarshal([]byte(argsValue), &args); err != nil || len(args) != 3 {
		t.Fatalf("decode MCP args %q: %v", argsValue, err)
	}
	return args[2]
}

func countConfigPrefix(args []string, prefix string) int {
	count := 0
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "-c" && strings.HasPrefix(args[i+1], prefix) {
			count++
			i++
		}
	}
	return count
}

func configValue(t *testing.T, args []string, prefix string) string {
	t.Helper()
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "-c" && strings.HasPrefix(args[i+1], prefix) {
			return strings.TrimPrefix(args[i+1], prefix)
		}
	}
	t.Fatalf("config prefix %q not found in %v", prefix, args)
	return ""
}
