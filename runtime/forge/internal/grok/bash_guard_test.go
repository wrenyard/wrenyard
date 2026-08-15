package grok

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

const testGrokGateMatcher = "Bash|run_terminal_cmd|run_terminal_command|Read|read_file|Grep|grep|Glob|ListDir|list_dir|Edit|Write|MultiEdit|search_replace"

func TestBashGuardEnforcesEffectiveAllowlistBeforeDisposableExecutable(t *testing.T) {
	policy := catalog.PolicyFor(catalog.PermissionEdit)
	capBash := []catalog.BashRule{{Pattern: "notesmd-cli *"}}
	allow, err := catalog.EffectiveBashAllow(policy, capBash)
	if err != nil {
		t.Fatal(err)
	}
	hookData, err := BashGuardHookBytes(filepath.Join(t.TempDir(), "Forge Guard.exe"), allow, runtime.GOOS)
	if err != nil {
		t.Fatal(err)
	}
	encodedAllow := guardPolicyFromHook(t, hookData)

	root := t.TempDir()
	marker := filepath.Join(root, "sentinel-created")
	mockName := "forge-guard-mock"
	mockPath := filepath.Join(root, mockName)
	mockData := []byte("#!/bin/sh\nprintf sentinel > sentinel-created\n")
	if runtime.GOOS == "windows" {
		mockPath += ".cmd"
		mockData = []byte("@echo sentinel>sentinel-created\r\n")
	}
	if err := os.WriteFile(mockPath, mockData, 0o700); err != nil {
		t.Fatal(err)
	}

	allowed := []string{
		"pwd",
		"rg forge internal",
		"git --no-optional-locks status --short",
		"Get-ChildItem -Name",
		"New-Item marker.txt",
		"notesmd-cli list",
		"pwd && rg forge | head -n 1",
	}
	for _, command := range allowed {
		t.Run("allow_"+safeTestName(command), func(t *testing.T) {
			decision, code := runGuardDecision(t, encodedAllow, "run_terminal_cmd", command)
			if code != 0 || decision != "allow" {
				t.Fatalf("guard(%q) = decision %q code %d, want allow/0", command, decision, code)
			}
		})
	}

	denied := []string{
		"curl https://example.invalid",
		"python -c print(1)",
		"git commit -m sentinel",
		mockName,
		mockName + " --write-sentinel",
		mockPath,
		filepath.Join(".", filepath.Base(mockPath)),
		"./" + filepath.Base(mockPath),
		"../" + filepath.Base(mockPath),
		filepath.Join(root, "rg") + " forge",
		"unknown-forge-command",
		"representative_unknown_42 --flag",
		"pwd && curl https://example.invalid",
		"rg forge | python -c print(1)",
	}
	for _, command := range denied {
		t.Run("deny_"+safeTestName(command), func(t *testing.T) {
			decision, code := runGuardDecision(t, encodedAllow, "run_terminal_command", command)
			if code != 2 || decision != "deny" {
				t.Fatalf("guard(%q) = decision %q code %d, want deny/2", command, decision, code)
			}
			if _, err := os.Stat(marker); !os.IsNotExist(err) {
				t.Fatalf("denied command created sentinel before execution: %v", err)
			}
		})
	}
}

func TestBashGuardErrorsAndUnknownShellNamesDenyExplicitly(t *testing.T) {
	allow, err := catalog.EffectiveBashAllow(catalog.PolicyFor(catalog.PermissionReadonly), nil)
	if err != nil {
		t.Fatal(err)
	}
	hookData, err := BashGuardHookBytes("forge", allow, runtime.GOOS)
	if err != nil {
		t.Fatal(err)
	}
	encodedAllow := guardPolicyFromHook(t, hookData)
	cases := []struct {
		name    string
		policy  string
		payload string
	}{
		{name: "missing policy", payload: `{"hookEventName":"pre_tool_use","toolName":"run_terminal_cmd","toolInput":{"command":"pwd"},"toolInputTruncated":false}`},
		{name: "malformed policy", policy: "not-base64", payload: `{"hookEventName":"pre_tool_use","toolName":"run_terminal_cmd","toolInput":{"command":"pwd"},"toolInputTruncated":false}`},
		{name: "malformed payload", policy: encodedAllow, payload: `{`},
		{name: "missing truncation metadata", policy: encodedAllow, payload: `{"hookEventName":"pre_tool_use","toolName":"run_terminal_cmd","toolInput":{"command":"pwd"}}`},
		{name: "null truncation metadata", policy: encodedAllow, payload: `{"hookEventName":"pre_tool_use","toolName":"run_terminal_cmd","toolInput":{"command":"pwd"},"toolInputTruncated":null}`},
		{name: "wrong truncation metadata type", policy: encodedAllow, payload: `{"hookEventName":"pre_tool_use","toolName":"run_terminal_cmd","toolInput":{"command":"pwd"},"toolInputTruncated":"false"}`},
		{name: "wrong truncation metadata field", policy: encodedAllow, payload: `{"hookEventName":"pre_tool_use","toolName":"run_terminal_cmd","toolInput":{"command":"pwd"},"tool_input_truncated":false}`},
		{name: "empty command", policy: encodedAllow, payload: `{"hookEventName":"pre_tool_use","toolName":"run_terminal_cmd","toolInput":{"command":""},"toolInputTruncated":false}`},
		{name: "unknown shell", policy: encodedAllow, payload: `{"hookEventName":"pre_tool_use","toolName":"new_shell_tool","toolInput":{"command":"pwd"},"toolInputTruncated":false}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var output bytes.Buffer
			if code := RunBashGuard(strings.NewReader(tc.payload), &output, tc.policy); code != 2 {
				t.Fatalf("code = %d, want 2; output=%s", code, output.String())
			}
			var decision map[string]string
			if err := json.Unmarshal(output.Bytes(), &decision); err != nil || decision["decision"] != "deny" || decision["reason"] == "" {
				t.Fatalf("explicit deny output = %q err=%v", output.String(), err)
			}
		})
	}
}

func TestBashGuardTruncationAndAmpersandDecisionsAtBuiltBinarySeam(t *testing.T) {
	allow, err := catalog.EffectiveBashAllow(catalog.PolicyFor(catalog.PermissionReadonly), nil)
	if err != nil {
		t.Fatal(err)
	}
	hookData, err := BashGuardHookBytes("forge", allow, runtime.GOOS)
	if err != nil {
		t.Fatal(err)
	}
	policy := guardPolicyFromHook(t, hookData)
	binary := buildForgeGuardBinary(t)
	root := t.TempDir()
	marker := filepath.Join(root, "must-not-exist")
	victim := filepath.Join(root, "victim.txt")
	if err := os.WriteFile(victim, []byte("preserve-sentinel\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name      string
		command   string
		truncated bool
		wantCode  int
	}{
		{name: "safe visible prefix is denied when truncated", command: "pwd", truncated: true, wantCode: 2},
		{name: "single ampersand is denied", command: "pwd & rg forge", truncated: false, wantCode: 2},
		{name: "safe and-and chain passes", command: "pwd && rg forge", truncated: false, wantCode: 0},
		{name: "non-truncated safe input passes", command: "pwd", truncated: false, wantCode: 0},
	}
	if runtime.GOOS == "windows" {
		cases = append(cases,
			struct {
				name      string
				command   string
				truncated bool
				wantCode  int
			}{name: "cmd backslash pipe is denied", command: `type harmless\| del victim.txt`, wantCode: 2},
			struct {
				name      string
				command   string
				truncated bool
				wantCode  int
			}{name: "PowerShell backslash semicolon is denied", command: `Get-Content harmless\; Remove-Item victim.txt`, wantCode: 2},
		)
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			payload, err := json.Marshal(map[string]any{
				"hookEventName": "pre_tool_use",
				"toolName":      "run_terminal_cmd", "toolInput": map[string]string{"command": tc.command},
				"toolInputTruncated": tc.truncated,
			})
			if err != nil {
				t.Fatal(err)
			}
			decision, code := runBuiltGuard(t, binary, policy, payload)
			if code != tc.wantCode {
				t.Fatalf("built guard decision=%q code=%d, want code=%d", decision, code, tc.wantCode)
			}
			if code == 0 && tc.truncated {
				// This models Grok's next production step: only an allow decision
				// can reach command execution. The omitted suffix would write the
				// sentinel if truncated input accidentally failed open.
				if err := os.WriteFile(marker, []byte("executed"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("truncated tool input reached command execution: %v", err)
	}
	if data, err := os.ReadFile(victim); err != nil || string(data) != "preserve-sentinel\n" {
		t.Fatalf("built guarded command changed victim sentinel: bytes=%q err=%v", data, err)
	}
}

func TestInstalledGrok02106PermissionAndHookCharacterization(t *testing.T) {
	if os.Getenv("FORGE_TEST_INSTALLED_GROK") != "1" {
		t.Skipf("set FORGE_TEST_INSTALLED_GROK=1 to run installed Grok integration probes")
	}
	grokPath, err := exec.LookPath("grok")
	if err != nil {
		t.Skip("installed Grok is not available")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	versionOutput, err := exec.CommandContext(ctx, grokPath, "--version").CombinedOutput()
	if err != nil || !strings.Contains(string(versionOutput), "grok 0.2.106") {
		t.Skipf("installed Grok is not 0.2.106: %s (%v)", strings.TrimSpace(string(versionOutput)), err)
	}
	helpOutput, err := exec.CommandContext(ctx, grokPath, "--help").CombinedOutput()
	if err != nil {
		t.Fatal(err)
	}
	for _, contract := range []string{"--allow <RULE>", "--deny <RULE>", "--always-approve"} {
		if !bytes.Contains(helpOutput, []byte(contract)) {
			t.Fatalf("installed help missing %q", contract)
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	toolDocs, err := os.ReadFile(filepath.Join(home, ".grok", "docs", "user-guide", "01-getting-started.md"))
	if err != nil {
		t.Skipf("installed Grok builtin source is unavailable: %v", err)
	}
	if !bytes.Contains(toolDocs, []byte("| `spawn_subagent` | Spawn parallel subagent sessions |")) {
		t.Fatal("installed Grok 0.2.106 builtin source does not identify spawn_subagent")
	}
	hookDocs, err := os.ReadFile(filepath.Join(home, ".grok", "docs", "user-guide", "10-hooks.md"))
	if err != nil {
		t.Skipf("installed Grok hook source is unavailable: %v", err)
	}
	if !bytes.Contains(hookDocs, []byte("payload also always includes `toolUseId` and `toolInputTruncated`")) {
		t.Fatal("installed Grok 0.2.106 hook source does not require toolInputTruncated")
	}
	docs, err := os.ReadFile(filepath.Join(home, ".grok", "docs", "user-guide", "22-permissions-and-safety.md"))
	if err != nil {
		t.Skipf("installed Grok permission source is unavailable: %v", err)
	}
	for _, sourceEvidence := range []string{
		"`deny` always wins",
		"you cannot combine these `allow` rules with a catch-all `deny` on `bash`",
		"A `PreToolUse` hook can enforce an allow list on the `Bash` tool that applies in every permission mode",
		"Hooks fail open",
	} {
		if !bytes.Contains(docs, []byte(sourceEvidence)) {
			t.Fatalf("installed permission source missing %q", sourceEvidence)
		}
	}

	allow, err := catalog.EffectiveBashAllow(catalog.PolicyFor(catalog.PermissionEdit), nil)
	if err != nil {
		t.Fatal(err)
	}
	hookData, err := BashGuardHookBytes("forge", allow, runtime.GOOS)
	if err != nil {
		t.Fatal(err)
	}
	isolatedHome := t.TempDir()
	hookDir := filepath.Join(isolatedHome, "hooks")
	if err := os.MkdirAll(hookDir, 0o700); err != nil {
		t.Fatal(err)
	}
	hookPath := filepath.Join(hookDir, "forge-bash-guard.json")
	if err := os.WriteFile(hookPath, hookData, 0o600); err != nil {
		t.Fatal(err)
	}
	inspect := exec.CommandContext(ctx, grokPath, "inspect", "--json")
	inspect.Dir = t.TempDir()
	inspect.Env = replaceEnv(os.Environ(), "GROK_HOME", isolatedHome)
	inspectOutput, err := inspect.CombinedOutput()
	if err != nil {
		t.Fatalf("installed Grok inspect failed: %v\n%s", err, inspectOutput)
	}
	var inspected struct {
		Hooks []struct {
			Event   string `json:"event"`
			Matcher string `json:"matcher"`
			Source  struct {
				Path string `json:"path"`
			} `json:"source"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal(inspectOutput, &inspected); err != nil {
		t.Fatalf("decode installed Grok inspect output: %v", err)
	}
	found := false
	for _, hook := range inspected.Hooks {
		if hook.Event == "PreToolUse" && hook.Matcher == testGrokGateMatcher && filepath.Clean(hook.Source.Path) == filepath.Clean(hookDir) {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("installed Grok did not discover the isolated global PreToolUse matcher: %+v", inspected.Hooks)
	}
}

func guardPolicyFromHook(t *testing.T, data []byte) string {
	t.Helper()
	var hook struct {
		Hooks map[string][]struct {
			Matcher string `json:"matcher"`
			Hooks   []struct {
				Type    string            `json:"type"`
				Command string            `json:"command"`
				Timeout int               `json:"timeout"`
				Env     map[string]string `json:"env"`
			} `json:"hooks"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal(data, &hook); err != nil {
		t.Fatal(err)
	}
	matchers := hook.Hooks["PreToolUse"]
	if len(matchers) != 1 || matchers[0].Matcher != testGrokGateMatcher || len(matchers[0].Hooks) != 1 {
		t.Fatalf("hook shape = %+v", hook)
	}
	handler := matchers[0].Hooks[0]
	if handler.Type != "command" || handler.Timeout <= 0 || handler.Env[BashGuardModeEnv] != "grok" {
		t.Fatalf("handler shape = %+v", handler)
	}
	return handler.Env[BashGuardAllowEnv]
}

func runGuardDecision(t *testing.T, policy, tool, command string) (string, int) {
	t.Helper()
	payload, err := json.Marshal(map[string]any{
		"hookEventName":      "pre_tool_use",
		"toolName":           tool,
		"toolInput":          map[string]string{"command": command},
		"toolInputTruncated": false,
	})
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	code := RunBashGuard(bytes.NewReader(payload), &output, policy)
	var decision map[string]string
	if err := json.Unmarshal(output.Bytes(), &decision); err != nil {
		t.Fatalf("decode guard output %q: %v", output.String(), err)
	}
	return decision["decision"], code
}

func buildForgeGuardBinary(t *testing.T) string {
	t.Helper()
	name := "forge-guard-test"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	path := filepath.Join(t.TempDir(), name)
	cmd := exec.Command("go", "build", "-o", path, "../../cmd/forge")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build Forge guard binary: %v\n%s", err, output)
	}
	return path
}

func runBuiltGuard(t *testing.T, binary, policy string, payload []byte) (string, int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary)
	cmd.Env = replaceEnv(replaceEnv(os.Environ(), BashGuardModeEnv, "grok"), BashGuardAllowEnv, policy)
	cmd.Stdin = bytes.NewReader(payload)
	output, err := cmd.Output()
	code := 0
	if err != nil {
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) {
			t.Fatalf("run built Forge guard: %v", err)
		}
		code = exitErr.ExitCode()
	}
	var result map[string]string
	if err := json.Unmarshal(output, &result); err != nil {
		t.Fatalf("decode built Forge guard output %q: %v", output, err)
	}
	return result["decision"], code
}

func safeTestName(value string) string {
	replacer := strings.NewReplacer(" ", "_", "\\", "_", "/", "_", ":", "_", "|", "_", "&", "_")
	name := replacer.Replace(value)
	if len(name) > 80 {
		name = name[:80]
	}
	return name
}

func replaceEnv(env []string, key, value string) []string {
	prefix := strings.ToUpper(key) + "="
	out := make([]string, 0, len(env)+1)
	for _, entry := range env {
		if strings.HasPrefix(strings.ToUpper(entry), prefix) {
			continue
		}
		out = append(out, entry)
	}
	return append(out, key+"="+value)
}
