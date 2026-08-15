package bashgate

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

func TestClientPayloadAdaptersApplyOneSegmentAwarePolicy(t *testing.T) {
	allow, err := catalog.EffectiveBashAllow(catalog.PolicyFor(catalog.PermissionReadonly), nil)
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name    string
		client  Client
		payload func(string) []byte
	}{
		{name: "grok", client: ClientGrok, payload: grokPayload},
		{name: "claude", client: ClientClaude, payload: claudePayload},
		{name: "codebuddy", client: ClientCodeBuddy, payload: claudePayload},
		{name: "opencode", client: ClientOpenCode, payload: claudePayload},
	}
	commands := []struct {
		name  string
		value string
		allow bool
	}{
		{name: "semicolon safe", value: "cat harmless ; head harmless", allow: true},
		{name: "and-and safe", value: "cat harmless && head harmless", allow: true},
		{name: "or-or safe", value: "cat harmless || head harmless", allow: true},
		{name: "pipe safe", value: "cat harmless | head -n 1", allow: true},
		{name: "CR safe", value: "cat harmless\rhead harmless", allow: true},
		{name: "LF safe", value: "cat harmless\nhead harmless", allow: true},
		{name: "CRLF safe", value: "cat harmless\r\nhead harmless", allow: true},
		{name: "rm second segment", value: "cat harmless ; rm victim", allow: false},
		{name: "tee second segment", value: "cat harmless | tee victim", allow: false},
		{name: "single ampersand", value: "cat harmless & head harmless", allow: false},
	}
	for _, adapter := range cases {
		t.Run(adapter.name, func(t *testing.T) {
			policy, err := EncodePolicy(adapter.client, allow, nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			for _, command := range commands {
				t.Run(command.name, func(t *testing.T) {
					code, output := runGate(adapter.client, policy, bytes.NewReader(adapter.payload(command.value)))
					if command.allow && code != 0 || !command.allow && code != 2 {
						t.Fatalf("BashGate(%q) code=%d output=%s", command.value, code, output)
					}
				})
			}
		})
	}
}

// TestEditGitRmDeletionPolicySurvivesHookReconstruction proves the encoded edit
// deletion rule Bash(git rm -- *) reaches both the native payload and the
// reconstructed JSON policy used by the guard process: exactly one recoverable
// tracked-file deletion is allowed, while globs, multiple operands, chaining,
// traversal, and readonly deletion are denied.
func TestEditGitRmDeletionPolicySurvivesHookReconstruction(t *testing.T) {
	allow, err := catalog.EffectiveBashAllow(catalog.PolicyFor(catalog.PermissionEdit), nil)
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name    string
		client  Client
		payload func(string) []byte
	}{
		{name: "claude", client: ClientClaude, payload: claudePayload},
		{name: "codebuddy", client: ClientCodeBuddy, payload: claudePayload},
	}
	commands := []struct {
		name  string
		value string
		allow bool
	}{
		{name: "single tracked file", value: "git rm -- notes.md", allow: true},
		{name: "nested tracked file", value: "git rm -- src/notes.md", allow: true},
		{name: "wildcard glob", value: "git rm -- *"},
		{name: "bracket pathspec", value: "git rm -- src/[ab].md"},
		{name: "multiple operands", value: "git rm -- a.md b.md"},
		{name: "chained deletion", value: "git rm -- notes.md ; git rm -- other.md"},
		{name: "parent traversal", value: "git rm -- ../notes.md"},
		{name: "quoted space operand", value: `git rm -- "notes file.md"`},
		{name: "missing operand", value: "git rm --"},
	}
	for _, adapter := range cases {
		t.Run(adapter.name, func(t *testing.T) {
			policy, err := EncodePolicy(adapter.client, allow, nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			for _, command := range commands {
				t.Run(command.name, func(t *testing.T) {
					code, output := runGate(adapter.client, policy, bytes.NewReader(adapter.payload(command.value)))
					if command.allow && code != 0 || !command.allow && code != 2 {
						t.Fatalf("BashGate(%q) code=%d output=%s", command.value, code, output)
					}
				})
			}
		})
	}
	// Readonly denies the same valid deletion surface.
	roAllow, err := catalog.EffectiveBashAllow(catalog.PolicyFor(catalog.PermissionReadonly), nil)
	if err != nil {
		t.Fatal(err)
	}
	roPolicy, err := EncodePolicy(ClientClaude, roAllow, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	code, output := runGate(ClientClaude, roPolicy, bytes.NewReader(claudePayload("git rm -- notes.md")))
	if code != 2 {
		t.Fatalf("readonly BashGate(git rm -- notes.md) code=%d output=%s", code, output)
	}
}

func TestCompoundDirectoryChangesUseEffectiveWorkingDirectory(t *testing.T) {
	workDir := t.TempDir()
	credentialDir := filepath.Join(t.TempDir(), "credentials")
	if err := os.MkdirAll(credentialDir, 0o700); err != nil {
		t.Fatal(err)
	}
	sentinel := "compound-cwd-credential-sentinel-91af"
	credential := filepath.Join(credentialDir, "auth.json")
	if err := os.WriteFile(credential, []byte(sentinel), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workDir, "public.txt"), []byte("public"), 0o600); err != nil {
		t.Fatal(err)
	}

	allow, err := catalog.EffectiveBashAllow(catalog.PolicyFor(catalog.PermissionReadonly), nil)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := EncodePolicy(ClientGrok, allow, nil, []SensitivePath{{
		Path: credential, DenyContainingDirEnumeration: true,
	}})
	if err != nil {
		t.Fatal(err)
	}
	quotedDir := `"` + strings.ReplaceAll(credentialDir, `"`, `\"`) + `"`
	cases := []struct {
		name    string
		command string
		allow   bool
	}{
		{name: "proc semicolon cat", command: "cd /proc/self; cat environ"},
		{name: "proc newline read", command: "cd /proc/self\nhead environ"},
		{name: "proc and grep", command: "cd /proc/self && grep sentinel environ"},
		{name: "proc or list", command: "cd /proc/self || pwd; ls ."},
		{name: "credential semicolon cat", command: "cd " + quotedDir + "; cat auth.json"},
		{name: "credential newline read", command: "cd " + quotedDir + "\nhead auth.json"},
		{name: "credential and grep", command: "cd " + quotedDir + " && grep sentinel auth.json"},
		{name: "credential or list", command: "cd " + quotedDir + " || pwd; ls ."},
		{name: "variable cd fails closed", command: `cd "$TARGET_DIR"; cat auth.json`},
		{name: "glob cd fails closed", command: "cd " + quotedDir + "*; cat auth.json"},
		{name: "malformed cd fails closed", command: "cd -- " + quotedDir + "; cat auth.json"},
		{name: "ordinary compound", command: "pwd; cat public.txt", allow: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			payload := grokToolPayloadWithCWD("run_terminal_cmd", map[string]any{"command": tc.command}, false, workDir)
			code, output := runGate(ClientGrok, policy, bytes.NewReader(payload))
			if tc.allow && code != 0 || !tc.allow && code != 2 {
				t.Fatalf("compound command %q code=%d output=%s", tc.command, code, output)
			}
			if strings.Contains(output, sentinel) {
				t.Fatal("compound cwd guard output exposed credential sentinel")
			}
		})
	}
}

func TestImplicitSearchRootsProtectSensitiveSourcesAndAllowExplicitSafeRoots(t *testing.T) {
	repository := t.TempDir()
	if err := os.Mkdir(filepath.Join(repository, ".git"), 0o700); err != nil {
		t.Fatal(err)
	}
	protectedDir := filepath.Join(repository, "protected")
	safeDir := filepath.Join(repository, "safe")
	for _, dir := range []string{protectedDir, safeDir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	sentinel := "implicit-search-credential-sentinel-509d"
	credential := filepath.Join(protectedDir, "auth.json")
	if err := os.WriteFile(credential, []byte(sentinel), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(safeDir, "public.txt"), []byte("forge public"), 0o600); err != nil {
		t.Fatal(err)
	}
	dialect, ok := catalog.BashShellDialectForPlatform(runtime.GOOS)
	if !ok {
		t.Fatal("missing host shell dialect")
	}
	policy, err := encodePolicyForShell(ClientGrok, nil, nil, []SensitivePath{{
		Path: credential, DenyContainingDirEnumeration: true,
	}}, dialect, true)
	if err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name    string
		command string
		cwd     string
		allow   bool
	}{
		{name: "rg pattern only from protected directory", command: `rg -a '.+'`, cwd: protectedDir},
		{name: "plain rg from protected directory fails closed", command: `rg`, cwd: protectedDir},
		{name: "rg separator pattern only from protected directory", command: `rg -a -- '.+'`, cwd: protectedDir},
		{name: "grep pattern only from protected directory", command: `grep -n -- sentinel`, cwd: protectedDir},
		{name: "select string pattern only from protected directory", command: `Select-String -Pattern sentinel`, cwd: protectedDir},
		{name: "git grep implicit repository root", command: `git --no-optional-locks grep -nH sentinel`, cwd: safeDir},
		{name: "proc cwd ripgrep implicit root", command: `cd /proc/self && rg -a '.+'`, cwd: safeDir},
		{name: "rg explicit safe root", command: `rg -a '.+' -- ` + safeDir, cwd: protectedDir, allow: true},
		{name: "rg pattern resembling credential remains pattern", command: `rg -- ` + credential + ` ` + safeDir, cwd: protectedDir, allow: true},
		{name: "rg explicit pattern option and safe root", command: `rg -e sentinel -- ` + safeDir, cwd: protectedDir, allow: true},
		{name: "grep explicit safe root", command: `grep -n sentinel -- ` + safeDir, cwd: protectedDir, allow: true},
		{name: "git grep explicit safe pathspec", command: `git --no-optional-locks grep sentinel -- safe`, cwd: repository, allow: true},
		{name: "ordinary workspace search", command: `rg forge safe`, cwd: repository, allow: true},
		{name: "ambiguous rg option fails closed", command: `rg --future-search-root value sentinel`, cwd: safeDir},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			payload := grokToolPayloadWithCWD("run_terminal_cmd", map[string]any{"command": tc.command}, false, tc.cwd)
			code, output := runGate(ClientGrok, policy, bytes.NewReader(payload))
			if tc.allow && code != 0 || !tc.allow && code != 2 {
				t.Fatalf("search command %q code=%d output=%s", tc.command, code, output)
			}
			if strings.Contains(output, sentinel) {
				t.Fatal("search guard output exposed credential sentinel")
			}
		})
	}

	for _, tc := range []struct {
		name  string
		input map[string]any
		cwd   string
		allow bool
	}{
		{name: "native pattern only protected cwd", input: map[string]any{"pattern": "sentinel"}, cwd: protectedDir},
		{name: "native query only protected cwd", input: map[string]any{"query": "sentinel"}, cwd: protectedDir},
		{name: "native explicit safe root", input: map[string]any{"regex": "sentinel", "root": safeDir}, cwd: protectedDir, allow: true},
		{name: "native ambiguous pattern aliases", input: map[string]any{"pattern": "one", "query": "two", "path": safeDir}, cwd: safeDir},
		{name: "native ambiguous path aliases", input: map[string]any{"pattern": "one", "path": safeDir, "root": safeDir}, cwd: safeDir},
	} {
		t.Run(tc.name, func(t *testing.T) {
			payload := grokToolPayloadWithCWD("grep", tc.input, false, tc.cwd)
			code, output := runGate(ClientGrok, policy, bytes.NewReader(payload))
			if tc.allow && code != 0 || !tc.allow && code != 2 {
				t.Fatalf("native search input=%v code=%d output=%s", tc.input, code, output)
			}
			if strings.Contains(output, sentinel) {
				t.Fatal("native search guard output exposed credential sentinel")
			}
		})
	}
}

func TestGrokYoloSensitivityParserAcceptsBackgroundSyntaxAndInspectsEverySegment(t *testing.T) {
	workDir := t.TempDir()
	protectedDir := filepath.Join(workDir, "protected")
	if err := os.MkdirAll(protectedDir, 0o700); err != nil {
		t.Fatal(err)
	}
	sentinel := "background-credential-sentinel-1a2f"
	credential := filepath.Join(protectedDir, "auth.json")
	if err := os.WriteFile(credential, []byte(sentinel), 0o600); err != nil {
		t.Fatal(err)
	}
	dialect, ok := catalog.BashShellDialectForPlatform(runtime.GOOS)
	if !ok {
		t.Fatal("missing host shell dialect")
	}
	policy, err := encodePolicyForShell(ClientGrok, nil, nil, []SensitivePath{{
		Path: credential, DenyContainingDirEnumeration: true,
	}}, dialect, true)
	if err != nil {
		t.Fatal(err)
	}
	quotedCredential := `"` + strings.ReplaceAll(credential, `"`, `\"`) + `"`
	quotedParent := `"` + strings.ReplaceAll(protectedDir, `"`, `\"`) + `"`
	for _, tc := range []struct {
		name    string
		command string
		allow   bool
	}{
		{name: "trailing background command", command: "sleep 1 &", allow: true},
		{name: "unrelated background and foreground", command: "sleep 1 & arbitrary-command --flag", allow: true},
		{name: "sensitive foreground after background", command: "sleep 1 & cat " + quotedCredential},
		{name: "sensitive background before foreground", command: "cat " + quotedCredential + " & sleep 1"},
		{name: "sensitive implicit search in background chain", command: "cd " + quotedParent + " && rg sentinel & sleep 1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			payload := grokToolPayloadWithCWD("run_terminal_cmd", map[string]any{"command": tc.command}, false, workDir)
			code, output := runGate(ClientGrok, policy, bytes.NewReader(payload))
			if tc.allow && code != 0 || !tc.allow && code != 2 {
				t.Fatalf("background command %q code=%d output=%s", tc.command, code, output)
			}
			if strings.Contains(output, sentinel) {
				t.Fatal("background guard output exposed credential sentinel")
			}
		})
	}
}

func TestPOSIXCompoundCaseVariantCannotExecute(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX executable identity regression")
	}
	allow, err := catalog.EffectiveBashAllow(catalog.PolicyFor(catalog.PermissionReadonly), nil)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := EncodePolicyForShell(ClientClaude, allow, nil, nil, catalog.BashShellPOSIX)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	sentinel := filepath.Join(root, "case-variant-ran")
	helper := filepath.Join(root, "CAT")
	if err := os.WriteFile(helper, []byte("#!/bin/sh\nprintf ran > '"+sentinel+"'\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "harmless"), []byte("safe\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	command := "cat harmless ; CAT"
	code, output := runGate(ClientClaude, policy, bytes.NewReader(claudePayload(command)))
	if code == 0 {
		cmd := exec.Command("sh", "-c", command)
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "PATH="+root+":"+os.Getenv("PATH"))
		_, _ = cmd.CombinedOutput()
	}
	if code != 2 || !strings.Contains(output, `"decision":"deny"`) {
		t.Fatalf("POSIX case-variant compound decision code=%d output=%s", code, output)
	}
	if _, err := os.Stat(sentinel); !os.IsNotExist(err) {
		t.Fatalf("case-variant executable ran despite denial: %v", err)
	}
}

func TestPolicyPayloadUsesExplicitChildExecutableCaseDialect(t *testing.T) {
	allow, err := catalog.EffectiveBashAllow(catalog.PolicyFor(catalog.PermissionReadonly), nil)
	if err != nil {
		t.Fatal(err)
	}
	command := "cat harmless ; CAT harmless"
	for _, tc := range []struct {
		goos string
		code int
	}{
		{goos: "linux", code: 2},
		{goos: "windows", code: 0},
	} {
		t.Run(tc.goos, func(t *testing.T) {
			policy, err := EncodePolicyForPlatform(ClientGrok, allow, nil, nil, tc.goos)
			if err != nil {
				t.Fatal(err)
			}
			code, output := runGate(ClientGrok, policy, bytes.NewReader(grokPayload(command)))
			if code != tc.code {
				t.Fatalf("explicit %s payload code=%d want=%d output=%s", tc.goos, code, tc.code, output)
			}
		})
	}
}

func TestPayloadBoundariesAndPolicyFailuresDeny(t *testing.T) {
	allow, err := catalog.EffectiveBashAllow(catalog.PolicyFor(catalog.PermissionReadonly), nil)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := EncodePolicy(ClientClaude, allow, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	truncated := append([]byte(`{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"cat harmless"},"padding":"`), bytes.Repeat([]byte("x"), maxPayloadBytes)...)
	cases := []struct {
		name   string
		client Client
		policy string
		input  io.Reader
	}{
		{name: "missing policy", client: ClientClaude, input: bytes.NewReader(claudePayload("cat harmless"))},
		{name: "policy client mismatch", client: ClientCodeBuddy, policy: policy, input: bytes.NewReader(claudePayload("cat harmless"))},
		{name: "malformed policy", client: ClientClaude, policy: "not-base64", input: bytes.NewReader(claudePayload("cat harmless"))},
		{name: "unknown client", client: Client("future"), policy: policy, input: bytes.NewReader(claudePayload("cat harmless"))},
		{name: "malformed payload", client: ClientClaude, policy: policy, input: strings.NewReader("{")},
		{name: "bounded truncated payload", client: ClientClaude, policy: policy, input: bytes.NewReader(truncated)},
		{name: "payload read error", client: ClientClaude, policy: policy, input: failingReader{}},
		{name: "reported truncation", client: ClientClaude, policy: policy, input: strings.NewReader(`{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"cat harmless"},"tool_input_truncated":true}`)},
		{name: "unknown Bash alias", client: ClientClaude, policy: policy, input: strings.NewReader(`{"hook_event_name":"PreToolUse","tool_name":"Shell","tool_input":{"command":"cat harmless"}}`)},
		{name: "wrong hook event", client: ClientClaude, policy: policy, input: strings.NewReader(`{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"cat harmless"}}`)},
		{name: "malformed command", client: ClientClaude, policy: policy, input: strings.NewReader(`{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":7}}`)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			code, output := runGate(tc.client, tc.policy, tc.input)
			if code != 2 || !strings.Contains(output, `"decision":"deny"`) {
				t.Fatalf("failure boundary code=%d output=%q", code, output)
			}
		})
	}
}

func TestCapabilityBashAndRestrictedProcessEnvironmentTools(t *testing.T) {
	allow, err := catalog.EffectiveBashAllow(catalog.PolicyFor(catalog.PermissionReadonly), []catalog.BashRule{{Pattern: "notesmd-cli *"}})
	if err != nil {
		t.Fatal(err)
	}
	policy, err := EncodePolicy(ClientGrok, allow, []string{"FORGE_GROK_ZHIPU_CODING_API_KEY"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	tools := []struct {
		name  string
		input map[string]any
		allow bool
	}{
		{name: "notesmd Bash cap", input: map[string]any{"tool": "run_terminal_cmd", "command": "notesmd-cli list"}, allow: true},
		{name: "safe read verified input", input: map[string]any{"tool": "read_file", "target_file": "README.md"}, allow: true},
		{name: "proc environ read", input: map[string]any{"tool": "read_file", "target_file": "/proc/self/environ"}},
		{name: "cleaned proc environ read", input: map[string]any{"tool": "read_file", "target_file": "/proc/self/../self/environ"}},
		{name: "proc environ glob read", input: map[string]any{"tool": "read_file", "target_file": "/proc/self/env*"}},
		{name: "proc pid glob read", input: map[string]any{"tool": "read_file", "target_file": "/proc/[0-9]*/environ"}},
		{name: "current proc pid alias", input: map[string]any{"tool": "read_file", "target_file": "/proc/" + strconv.Itoa(os.Getpid()) + "/environ"}},
		{name: "proc pid environ read", input: map[string]any{"tool": "Read", "file_path": "/proc/123/task/456/environ"}},
		{name: "PowerShell provider read", input: map[string]any{"tool": "read_file", "path": "Env:FORGE_GROK_ZHIPU_CODING_API_KEY"}},
		{name: "PowerShell provider glob", input: map[string]any{"tool": "read_file", "path": `Env:\\*`}},
		{name: "environment provider read", input: map[string]any{"tool": "read_file", "path": "Microsoft.PowerShell.Core\\Environment::FORGE_GROK_ZHIPU_CODING_API_KEY"}},
		{name: "environment provider glob", input: map[string]any{"tool": "read_file", "path": "Microsoft.PowerShell.Core\\Environment::*"}},
		{name: "grep proc environment", input: map[string]any{"tool": "grep", "pattern": "anything", "path": "/proc/thread-self/environ"}},
		{name: "grep selected variable", input: map[string]any{"tool": "Grep", "pattern": "FORGE_GROK_ZHIPU_CODING_API_KEY", "path": "."}},
		{name: "list proc self", input: map[string]any{"tool": "list_dir", "target_directory": "/proc/self"}},
		{name: "glob proc pid", input: map[string]any{"tool": "Glob", "path": "/proc/123"}},
		{name: "cat proc environ", input: map[string]any{"tool": "Bash", "command": "cat /proc/self/environ"}},
		{name: "file attached namefile proc environ", input: map[string]any{"tool": "Bash", "command": "file -f/proc/self/environ harmless"}},
		{name: "git grep attached pattern file proc environ", input: map[string]any{"tool": "Bash", "command": "git --no-optional-locks grep -f/proc/self/environ"}},
		{name: "PowerShell env enumeration", input: map[string]any{"tool": "run_terminal_cmd", "command": "Get-ChildItem Env:"}},
		{name: "environment enumeration", input: map[string]any{"tool": "run_terminal_cmd", "command": "env"}},
		{name: "direct selected variable", input: map[string]any{"tool": "run_terminal_cmd", "command": "Get-Content Env:FORGE_GROK_ZHIPU_CODING_API_KEY"}},
		{name: "malformed read", input: map[string]any{"tool": "read_file", "path": 7}},
		{name: "malformed grep", input: map[string]any{"tool": "grep", "path": "."}},
		{name: "malformed list", input: map[string]any{"tool": "list_dir"}},
	}
	for _, tc := range tools {
		t.Run(tc.name, func(t *testing.T) {
			tool := tc.input["tool"].(string)
			delete(tc.input, "tool")
			payload := grokToolPayload(tool, tc.input, false)
			code, output := runGate(ClientGrok, policy, bytes.NewReader(payload))
			if tc.allow && code != 0 || !tc.allow && code != 2 {
				t.Fatalf("tool %s input=%v code=%d output=%s", tool, tc.input, code, output)
			}
		})
	}
	code, output := runGate(ClientGrok, policy, bytes.NewReader(grokToolPayload("read_file", map[string]any{"path": "README.md"}, true)))
	if code != 2 {
		t.Fatalf("truncated read_file input code=%d output=%s", code, output)
	}
}

func TestBoundedGlobAndCanonicalProcessAliasesFailClosedWithoutLeaking(t *testing.T) {
	workDir := t.TempDir()
	benign := filepath.Join(workDir, "benign.txt")
	if err := os.WriteFile(benign, []byte("public"), 0o600); err != nil {
		t.Fatal(err)
	}
	allow, err := catalog.EffectiveBashAllow(catalog.PolicyFor(catalog.PermissionReadonly), nil)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := EncodePolicy(ClientGrok, allow, []string{"FORGE_SECRET_SENTINEL"}, nil)
	if err != nil {
		t.Fatal(err)
	}

	benignPayload, _ := json.Marshal(map[string]any{
		"hookEventName": "pre_tool_use", "toolName": "Glob",
		"toolInput":          map[string]any{"path": filepath.Join(workDir, "*.txt")},
		"toolInputTruncated": false, "cwd": workDir,
	})
	if code, output := runGate(ClientGrok, policy, bytes.NewReader(benignPayload)); code != 0 {
		t.Fatalf("bounded benign glob denied: code=%d output=%s", code, output)
	}

	largeDir := t.TempDir()
	for index := 0; index <= maxGuardGlobMatches; index++ {
		path := filepath.Join(largeDir, fmt.Sprintf("entry-%03d.txt", index))
		if err := os.WriteFile(path, []byte("public"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	largePayload, _ := json.Marshal(map[string]any{
		"hookEventName": "pre_tool_use", "toolName": "Glob",
		"toolInput":          map[string]any{"path": filepath.Join(largeDir, "*.txt")},
		"toolInputTruncated": false, "cwd": workDir,
	})
	code, output := runGate(ClientGrok, policy, bytes.NewReader(largePayload))
	if code != 2 || strings.Contains(output, "FORGE_SECRET_SENTINEL") {
		t.Fatalf("over-bound glob decision code=%d output=%s", code, output)
	}

	if runtime.GOOS != "windows" {
		target := "/proc/self/environ"
		info, statErr := os.Stat(target)
		if statErr != nil || !info.Mode().IsRegular() {
			t.Skipf("process environment target unavailable: %v", statErr)
		}
		alias := filepath.Join(t.TempDir(), "process-environment-alias")
		if err := os.Symlink(target, alias); err != nil {
			t.Skipf("process environment symlink alias unavailable: %v", err)
		}
		aliasPayload, _ := json.Marshal(map[string]any{
			"hookEventName": "pre_tool_use", "toolName": "read_file",
			"toolInput":          map[string]any{"file_path": alias},
			"toolInputTruncated": false, "cwd": workDir,
		})
		code, output = runGate(ClientGrok, policy, bytes.NewReader(aliasPayload))
		if code != 2 || strings.Contains(output, "FORGE_SECRET_SENTINEL") {
			t.Fatalf("process symlink alias decision code=%d output=%s", code, output)
		}
	}
}

func TestGrokEditGuardAllowsWorkspaceEditAndBlocksCredentialMutation(t *testing.T) {
	workDir := t.TempDir()
	sourceHome := t.TempDir()
	runHome := t.TempDir()
	sentinel := "oauth-edit-sentinel-481d"
	source := filepath.Join(sourceHome, ".grok", "auth.json")
	destination := filepath.Join(runHome, "auth.json")
	for _, path := range []string{source, destination} {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(sentinel), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("HOME", sourceHome)
	t.Setenv("USERPROFILE", sourceHome)
	t.Setenv("GROK_HOME", runHome)
	allow, err := catalog.EffectiveBashAllow(catalog.PolicyFor(catalog.PermissionEdit), nil)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := EncodePolicy(ClientGrok, allow, nil, []SensitivePath{
		{Path: source, DenyContainingDirEnumeration: true},
		{Path: destination, DenyContainingDirEnumeration: true},
	})
	if err != nil {
		t.Fatal(err)
	}

	ordinary := filepath.Join(workDir, "ordinary.txt")
	if err := os.WriteFile(ordinary, []byte("before"), 0o600); err != nil {
		t.Fatal(err)
	}
	ordinaryInput := map[string]any{"file_path": ordinary, "old_string": "before", "new_string": "after", "replace_all": false}
	code, output := runGate(ClientGrok, policy, bytes.NewReader(grokToolPayloadWithCWD("search_replace", ordinaryInput, false, workDir)))
	if code == 0 {
		applyGuardedReplacement(t, ordinary, "before", "after")
	}
	if code != 0 || strings.Contains(output, sentinel) {
		t.Fatalf("ordinary edit decision code=%d output=%s", code, output)
	}
	if data, err := os.ReadFile(ordinary); err != nil || string(data) != "after" {
		t.Fatalf("ordinary edit did not succeed: bytes=%q err=%v", data, err)
	}

	for _, tc := range []struct {
		name string
		tool string
		path string
	}{
		{name: "canonical source", tool: "search_replace", path: source},
		{name: "source dot alias", tool: "Edit", path: filepath.Join(sourceHome, ".grok", ".", "sub", "..", "auth.json")},
		{name: "copied home alias", tool: "Write", path: "$GROK_HOME/auth.json"},
		{name: "copied absolute", tool: "MultiEdit", path: destination},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input := map[string]any{"file_path": tc.path, "old_string": sentinel, "new_string": "mutated", "replace_all": false}
			code, output := runGate(ClientGrok, policy, bytes.NewReader(grokToolPayloadWithCWD(tc.tool, input, false, workDir)))
			if code == 0 {
				applyGuardedReplacement(t, tc.path, sentinel, "mutated")
			}
			if code != 2 || strings.Contains(output, sentinel) || strings.Contains(output, source) || strings.Contains(output, destination) {
				t.Fatalf("credential edit decision code=%d output=%s", code, output)
			}
			for _, path := range []string{source, destination} {
				if data, err := os.ReadFile(path); err != nil || string(data) != sentinel {
					t.Fatalf("credential bytes changed: bytes=%q err=%v", data, err)
				}
			}
		})
	}

	for _, payload := range [][]byte{
		grokToolPayloadWithCWD("search_replace", map[string]any{"file_path": ordinary, "new_string": "after"}, false, workDir),
		grokToolPayloadWithCWD("search_replace", map[string]any{"file_path": ordinary, "old_string": "after", "new_string": "again"}, true, workDir),
		grokToolPayloadWithCWD("search_replace", map[string]any{"unknown_path": ordinary, "old_string": "after", "new_string": "again"}, false, workDir),
	} {
		if code, output := runGate(ClientGrok, policy, bytes.NewReader(payload)); code != 2 || strings.Contains(output, sentinel) {
			t.Fatalf("malformed edit decision code=%d output=%s", code, output)
		}
	}
}

func grokToolPayloadWithCWD(tool string, input map[string]any, truncated bool, cwd string) []byte {
	data, _ := json.Marshal(map[string]any{
		"hookEventName": "pre_tool_use", "toolName": tool, "toolInput": input,
		"toolInputTruncated": truncated, "cwd": cwd,
	})
	return data
}

func applyGuardedReplacement(t *testing.T, path, oldValue, newValue string) {
	t.Helper()
	path, _ = expandChildHomePath(path)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, bytes.Replace(data, []byte(oldValue), []byte(newValue), 1), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestClusteredWriterAndHelperOptionsNeverReachExecution(t *testing.T) {
	allow, err := catalog.EffectiveBashAllow(catalog.PolicyFor(catalog.PermissionReadonly), nil)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := EncodePolicy(ClientGrok, allow, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	for _, name := range []string{"tree", "file", "git", "rg"} {
		writeSentinelCommand(t, bin, name)
	}
	oldPath := os.Getenv("PATH")
	t.Setenv("PATH", bin+string(os.PathListSeparator)+oldPath)

	cases := []struct {
		name    string
		command string
		allow   bool
	}{
		{name: "clustered tree output", command: "tree -ao" + filepath.Join(t.TempDir(), "tree-output") + " ."},
		{name: "clustered file compile magic", command: "file -bCm ./writer.magic"},
		{name: "file magic helper", command: "file -bm./writer.magic go.mod"},
		{name: "clustered git pager", command: "git --no-optional-locks grep -nOsh pattern"},
		{name: "git external helper", command: "git --no-optional-locks grep --ext-grep pattern"},
		{name: "ripgrep preprocessor helper", command: "rg --pre writer-helper pattern ."},
		{name: "ordinary tree", command: "tree -aL 2 .", allow: true},
		{name: "ordinary file", command: "file -bi go.mod", allow: true},
		{name: "ordinary git grep", command: "git --no-optional-locks grep -nH pattern", allow: true},
	}
	for index, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			marker := filepath.Join(t.TempDir(), "executed-"+strconv.Itoa(index))
			t.Setenv("FORGE_TEST_EXECUTED", marker)
			code, output := runGate(ClientGrok, policy, bytes.NewReader(grokPayload(tc.command)))
			if code == 0 {
				executeGuardedCommand(t, tc.command)
			}
			if tc.allow {
				if code != 0 {
					t.Fatalf("safe command denied: code=%d output=%s", code, output)
				}
				if _, err := os.Stat(marker); err != nil {
					t.Fatalf("safe command did not execute: %v", err)
				}
				return
			}
			if code != 2 || !strings.Contains(output, `"decision":"deny"`) {
				t.Fatalf("dangerous command decision code=%d output=%s", code, output)
			}
			if _, err := os.Stat(marker); !os.IsNotExist(err) {
				t.Fatalf("sentinel writer reached execution: %v", err)
			}
		})
	}
}

func writeSentinelCommand(t *testing.T, dir, name string) {
	t.Helper()
	path := filepath.Join(dir, name)
	content := "#!/bin/sh\nprintf executed > \"$FORGE_TEST_EXECUTED\"\n"
	if runtime.GOOS == "windows" {
		path += ".cmd"
		content = "@echo off\r\n>\"%FORGE_TEST_EXECUTED%\" echo executed\r\n"
	}
	if err := os.WriteFile(path, []byte(content), 0o700); err != nil {
		t.Fatal(err)
	}
}

func executeGuardedCommand(t *testing.T, command string) {
	t.Helper()
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("cmd.exe", "/d", "/s", "/c", command)
	} else {
		cmd = exec.Command("sh", "-c", command)
	}
	cmd.Env = os.Environ()
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("execute allowed command: %v: %s", err, output)
	}
}

func TestSensitiveFilesystemPathsDenyCredentialReadsAndContainingDirectoryEnumeration(t *testing.T) {
	home := t.TempDir()
	workDir := t.TempDir()
	runHome := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("GROK_HOME", runHome)

	sentinel := "oauth-credential-sentinel-7af31"
	source := filepath.Join(home, ".grok", "auth.json")
	destination := filepath.Join(runHome, "auth.json")
	for _, path := range []string{source, destination} {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(sentinel), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	unrelated := filepath.Join(home, "notes.txt")
	if err := os.WriteFile(unrelated, []byte("public notes"), 0o600); err != nil {
		t.Fatal(err)
	}
	allow, err := catalog.EffectiveBashAllow(catalog.PolicyFor(catalog.PermissionReadonly), []catalog.BashRule{{Pattern: "notesmd-cli *"}})
	if err != nil {
		t.Fatal(err)
	}
	policy, err := EncodePolicy(ClientGrok, allow, nil, []SensitivePath{
		{Path: source, DenyContainingDirEnumeration: true},
		{Path: destination, DenyContainingDirEnumeration: true},
	})
	if err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name  string
		tool  string
		input map[string]any
		cwd   string
		allow bool
	}{
		{name: "bash source absolute", tool: "run_terminal_cmd", input: map[string]any{"command": "cat " + source}, cwd: workDir},
		{name: "bash destination absolute", tool: "Bash", input: map[string]any{"command": "Get-Content " + destination}, cwd: workDir},
		{name: "bash source tilde", tool: "run_terminal_command", input: map[string]any{"command": "cat ~/.grok/auth.json"}, cwd: workDir},
		{name: "bash source home variable", tool: "run_terminal_cmd", input: map[string]any{"command": "cat $HOME/.grok/auth.json"}, cwd: workDir},
		{name: "bash destination home variable", tool: "run_terminal_cmd", input: map[string]any{"command": "Get-Content $GROK_HOME/auth.json"}, cwd: workDir},
		{name: "bash source relative", tool: "run_terminal_cmd", input: map[string]any{"command": "cat .grok/auth.json"}, cwd: home},
		{name: "bash attached PowerShell path", tool: "run_terminal_cmd", input: map[string]any{"command": "Get-Content -LiteralPath:" + source}, cwd: workDir},
		{name: "capability command source argument", tool: "run_terminal_cmd", input: map[string]any{"command": "notesmd-cli export " + source}, cwd: workDir},
		{name: "read source", tool: "read_file", input: map[string]any{"target_file": source}, cwd: workDir},
		{name: "read source cleaned dot alias", tool: "read_file", input: map[string]any{"target_file": filepath.Join(home, ".grok", ".", "child", "..", "auth.json")}, cwd: workDir},
		{name: "read source glob", tool: "read_file", input: map[string]any{"target_file": filepath.Join(home, ".grok", "auth*")}, cwd: workDir},
		{name: "read destination home alias", tool: "read_file", input: map[string]any{"path": `%GROK_HOME%\auth.json`}, cwd: workDir},
		{name: "grep source", tool: "grep", input: map[string]any{"pattern": "oauth", "path": source}, cwd: workDir},
		{name: "grep source ancestor", tool: "grep", input: map[string]any{"pattern": "oauth", "path": home}, cwd: workDir},
		{name: "list source parent", tool: "list_dir", input: map[string]any{"target_directory": filepath.Dir(source)}, cwd: workDir},
		{name: "list destination parent", tool: "Glob", input: map[string]any{"path": runHome}, cwd: workDir},
		{name: "malformed home alias", tool: "read_file", input: map[string]any{"path": "~another-user/.grok/auth.json"}, cwd: workDir},
		{name: "unrelated file in user tree", tool: "read_file", input: map[string]any{"path": unrelated}, cwd: workDir, allow: true},
		{name: "unrelated parent listing", tool: "list_dir", input: map[string]any{"path": home}, cwd: workDir, allow: true},
		{name: "capability command unrelated argument", tool: "run_terminal_cmd", input: map[string]any{"command": "notesmd-cli inspect " + unrelated}, cwd: workDir, allow: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			payload, err := json.Marshal(map[string]any{
				"hookEventName": "pre_tool_use", "toolName": tc.tool, "toolInput": tc.input,
				"toolInputTruncated": false, "cwd": tc.cwd,
			})
			if err != nil {
				t.Fatal(err)
			}
			code, output := runGate(ClientGrok, policy, bytes.NewReader(payload))
			if tc.allow && code != 0 || !tc.allow && code != 2 {
				t.Fatalf("guard code=%d output=%s", code, output)
			}
			if strings.Contains(output, sentinel) {
				t.Fatal("guard output exposed credential sentinel")
			}
		})
	}

	t.Run("hard link alias", func(t *testing.T) {
		alias := filepath.Join(workDir, "hardlink-auth.json")
		if err := os.Link(source, alias); err != nil {
			t.Skipf("hard links are unavailable: %v", err)
		}
		payload := grokToolPayload("read_file", map[string]any{"path": alias}, false)
		code, output := runGate(ClientGrok, policy, bytes.NewReader(payload))
		if code != 2 || strings.Contains(output, sentinel) {
			t.Fatalf("hard-link guard code=%d output=%s", code, output)
		}
	})

	t.Run("symlink or junction alias", func(t *testing.T) {
		aliasRoot := filepath.Join(workDir, "credential-alias")
		if err := os.Symlink(filepath.Dir(source), aliasRoot); err != nil {
			t.Skipf("directory symlinks or junctions are unavailable: %v", err)
		}
		payload := grokToolPayload("read_file", map[string]any{"path": filepath.Join(aliasRoot, "auth.json")}, false)
		code, output := runGate(ClientGrok, policy, bytes.NewReader(payload))
		if code != 2 || strings.Contains(output, sentinel) {
			t.Fatalf("symlink guard code=%d output=%s", code, output)
		}
	})
}

func TestClaudeFamilyHookMapsGuardProcessErrorToBlockingExit(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "missing Forge hook")
	command, err := claudeFamilyHookCommand(missing, runtime.GOOS)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "windows" {
		if command != windowsClaudeHookCommand || strings.Contains(command, missing) || !strings.HasSuffix(command, "|| exit 2") {
			t.Fatalf("Windows fail-closed hook command = %q", command)
		}
		env, envErr := claudeFamilyHookEnv(missing, "windows")
		if envErr != nil {
			t.Fatal(envErr)
		}
		if env[ExecutableEnv] != `"`+missing+`"` {
			t.Fatalf("Windows hook executable env = %q", env[ExecutableEnv])
		}
		return
	}
	cmd := exec.Command("/bin/sh", "-c", command)
	err = cmd.Run()
	exitErr, ok := err.(*exec.ExitError)
	if !ok || exitErr.ExitCode() != 2 {
		t.Fatalf("guard process error = %v, want blocking exit 2; command=%q", err, command)
	}
}

func TestClaudeFamilyHookAdapterOSMatrix(t *testing.T) {
	executable := `C:\Program Files\Forge Guard\forge.exe`
	windowsCommand, err := claudeFamilyHookCommand(executable, "windows")
	if err != nil {
		t.Fatal(err)
	}
	if windowsCommand != windowsClaudeHookCommand || strings.Contains(windowsCommand, executable) {
		t.Fatalf("Windows hook command = %q", windowsCommand)
	}
	windowsEnv, err := claudeFamilyHookEnv(executable, "windows")
	if err != nil {
		t.Fatal(err)
	}
	if len(windowsEnv) != 1 || windowsEnv[ExecutableEnv] != `"`+executable+`"` {
		t.Fatalf("Windows hook env = %#v", windowsEnv)
	}

	linuxCommand, err := claudeFamilyHookCommand(executable, "linux")
	if err != nil {
		t.Fatal(err)
	}
	if linuxCommand != `"C:/Program Files/Forge Guard/forge.exe" || exit 2` {
		t.Fatalf("non-Windows hook command changed: %q", linuxCommand)
	}
	linuxEnv, err := claudeFamilyHookEnv(executable, "linux")
	if err != nil || len(linuxEnv) != 0 {
		t.Fatalf("non-Windows hook env = %#v, %v", linuxEnv, err)
	}
}

func runGate(client Client, policy string, input io.Reader) (int, string) {
	var output bytes.Buffer
	code := Run(input, &output, string(client), policy)
	return code, output.String()
}

func claudePayload(command string) []byte {
	data, _ := json.Marshal(map[string]any{
		"hook_event_name": "PreToolUse", "tool_name": "Bash",
		"tool_input": map[string]any{"command": command},
	})
	return data
}

func grokPayload(command string) []byte {
	return grokToolPayload("run_terminal_cmd", map[string]any{"command": command}, false)
}

func grokToolPayload(tool string, input map[string]any, truncated bool) []byte {
	data, _ := json.Marshal(map[string]any{
		"hookEventName": "pre_tool_use", "toolName": tool,
		"toolInput": input, "toolInputTruncated": truncated,
	})
	return data
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errors.New("synthetic hook read failure") }
