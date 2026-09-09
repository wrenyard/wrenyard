package forge

import (
	"path/filepath"
	"strings"
	"testing"
)

func bindCodeBuddyDirectRunFixture(t *testing.T, uid, wireModel string) {
	t.Helper()
	writeCodeBuddyAuthFixture(t, "ioa.example.com", uid, "synthetic-direct-run-token")
	active := authStatusResolver().CodeBuddyActiveScope()
	if !active.OK || active.Environment != "ioa" || active.Scope == "" {
		t.Fatalf("synthetic direct-run CodeBuddy fixture did not resolve: %+v", active)
	}
	setCodeBuddyExpectedTuple(t, active.Scope, active.Environment, wireModel)
}

func TestParseDirectRunRejectsDashDashPromptEscape(t *testing.T) {
	_, err := parseDirectRunArgs([]string{"-p", "codex", "--", "hello"})
	if err == nil {
		t.Fatal("expected -- prompt escape to be rejected")
	}
	if !strings.Contains(err.Error(), "does not support -- before the prompt") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestParseDirectRunRejectsMCPPassthrough(t *testing.T) {
	for _, args := range [][]string{
		{"-p", "codex", "--mcp", "{}", "hello"},
		{"-p", "codex", "-m", "{}", "hello"},
	} {
		_, err := parseDirectRunArgs(args)
		if err == nil {
			t.Fatalf("expected direct runtime to reject MCP passthrough args %v", args)
		}
		if !strings.Contains(err.Error(), "MCP") && !strings.Contains(err.Error(), "mcp") {
			t.Fatalf("expected MCP rejection for args %v, got %v", args, err)
		}
	}
}

func TestCombineDirectPrompt(t *testing.T) {
	tests := []struct {
		name  string
		argv  string
		stdin string
		want  string
	}{
		{name: "argv only", argv: "  argv prompt  ", want: "argv prompt"},
		{name: "stdin only", stdin: "\nstdin context\n", want: "stdin context"},
		{name: "both", argv: " argv prompt ", stdin: " stdin context\n", want: "argv prompt\n\nPiped context:\nstdin context"},
		{name: "empty", want: ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := combineDirectPrompt(tt.argv, tt.stdin); got != tt.want {
				t.Fatalf("combineDirectPrompt() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestCCKimiAuthIncludesManagedSettings(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	setFakeClientsOnPath(t, "claude")
	setTestAuth(t, "kimi-coding", "token-kimi")

	plan, err := buildDirectRunPlan(directPlanInput{Profile: "cc-kimi", Prompt: "work", CWD: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	for key, want := range map[string]string{
		"ANTHROPIC_API_KEY":               "test-gateway-token",
		"ANTHROPIC_AUTH_TOKEN":            "test-gateway-token",
		"ANTHROPIC_BASE_URL":              "http://127.0.0.1:4312/gateway/anthropic/v1",
		"ANTHROPIC_MODEL":                 "kimi-coding/k3[1m]",
		"CLAUDE_CODE_SUBAGENT_MODEL":      "kimi-coding/k3[1m]",
		"ENABLE_TOOL_SEARCH":              "false",
		"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "1048576",
		"CLAUDE_CODE_MAX_CONTEXT_TOKENS":  "1048576",
		"FORGE_PROFILE":                   "cc-kimi",
	} {
		if got := plan.Env[key]; got != want {
			t.Fatalf("plan.Env[%s] = %q, want %q; env=%#v", key, got, want, plan.Env)
		}
	}
	if plan.ConfigDir != directCCConfigDir() {
		t.Fatalf("plan config dir = %q, want %q", plan.ConfigDir, directCCConfigDir())
	}
	if !contains(plan.Command, "--settings") {
		t.Fatalf("cc-kimi agent command should include inline settings for model overrides: %#v", plan.Command)
	}
	if contains(plan.Command, "agents") {
		t.Fatalf("cc-kimi direct runtime must remain headless and must not enter Agent View: %#v", plan.Command)
	}
}

func TestDirectRunCodexSparkKeepsCodexCommandAndProfile(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	t.Setenv("FORGE_REPO_DIR", t.TempDir())
	setFakeClientsOnPath(t, "codex")

	plan, err := buildDirectRunPlan(directPlanInput{Profile: "codex-spark", Prompt: "inspect", CWD: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Command[0] != "codex" {
		t.Fatalf("codex-spark command[0] = %q, want codex; command=%#v", plan.Command[0], plan.Command)
	}
	if !contains(plan.Command, "gpt-5.3-codex-spark") {
		t.Fatalf("codex-spark must preserve CODEX_MODEL value: %#v", plan.Command)
	}
	if plan.Env["FORGE_PROFILE"] != "codex-spark" {
		t.Fatalf("codex-spark FORGE_PROFILE = %q, want codex-spark", plan.Env["FORGE_PROFILE"])
	}
}

func TestDirectRunCBKimiSelectsCodeBuddyWithKimiK3(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	t.Setenv("FORGE_REPO_DIR", t.TempDir())
	setFakeClientsOnPath(t, "codebuddy")
	bindCodeBuddyDirectRunFixture(t, "uid-direct-kimi", "kimi-k3")

	plan, err := buildDirectRunPlan(directPlanInput{Profile: "cb-kimi", Prompt: "work", CWD: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	// Windows ResolveBinary prefers the isolated NodeEntry (node + script) so
	// tests never need a real codebuddy.cmd shim; Unix still resolves the bare name.
	base := filepath.Base(plan.Command[0])
	if base != "codebuddy" && base != "node" && base != "node.exe" {
		t.Fatalf("cb-kimi command[0] = %q, want codebuddy or node; command=%#v", plan.Command[0], plan.Command)
	}
	if base == "node" || base == "node.exe" {
		if len(plan.Command) < 2 || !strings.Contains(plan.Command[1], "codebuddy") {
			t.Fatalf("cb-kimi node entry missing codebuddy script: %#v", plan.Command)
		}
	}
	if plan.Env["FORGE_PROFILE"] != "cb-kimi" {
		t.Fatalf("cb-kimi FORGE_PROFILE = %q, want cb-kimi", plan.Env["FORGE_PROFILE"])
	}
	// Verify the command contains --model kimi-k3 in correct order.
	foundModel := false
	for i, a := range plan.Command {
		if a == "--model" && i+1 < len(plan.Command) && plan.Command[i+1] == "kimi-k3" {
			foundModel = true
			break
		}
	}
	if !foundModel {
		t.Fatalf("cb-kimi command must contain ordered --model kimi-k3: %#v", plan.Command)
	}
	// Verify NO Kimi Coding / Anthropic endpoint or API-key env is injected.
	for _, key := range []string{"ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"} {
		if _, ok := plan.Env[key]; ok {
			t.Fatalf("cb-kimi must not inject %s, got %q", key, plan.Env[key])
		}
	}
}

func TestDirectRunCBHYUsesDaemonResolvedUpstreamModel(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	t.Setenv("FORGE_REPO_DIR", t.TempDir())
	setFakeClientsOnPath(t, "codebuddy")
	bindCodeBuddyDirectRunFixture(t, "uid-direct-hy", "hy4-preview-ioa")

	plan, err := buildDirectRunPlan(directPlanInput{Profile: "cb-hy", Prompt: "work", CWD: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for i, arg := range plan.Command {
		if arg == "--model" && i+1 < len(plan.Command) && plan.Command[i+1] == "hy4-preview-ioa" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("cb-hy command must consume the daemon-resolved upstream model: %#v", plan.Command)
	}
}
