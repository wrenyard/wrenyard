package grok

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/bashgate"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

const installedGrokEnv = "FORGE_TEST_INSTALLED_GROK"

func requireInstalledGrok(t *testing.T) {
	t.Helper()
	if os.Getenv(installedGrokEnv) != "1" {
		t.Skipf("set %s=1 to run installed Grok integration probes", installedGrokEnv)
	}
}

func TestInstalledGrok02106OAuthPathsUseRestrictedLocalMock(t *testing.T) {
	requireInstalledGrok(t)
	grokPath, err := exec.LookPath("grok")
	if err != nil {
		t.Skip("installed Grok is not available")
	}
	versionOutput, err := exec.Command(grokPath, "--version").CombinedOutput()
	if err != nil || !strings.Contains(string(versionOutput), "grok 0.2.106") {
		t.Skipf("installed Grok is not 0.2.106: %s (%v)", strings.TrimSpace(string(versionOutput)), err)
	}
	forgeBinary := buildForgeGuardBinary(t)
	sourceHome := t.TempDir()
	source := filepath.Join(sourceHome, ".grok", "auth.json")
	if err := os.MkdirAll(filepath.Dir(source), 0o700); err != nil {
		t.Fatal(err)
	}
	sentinel := []byte(`{"access_token":"installed-oauth-sentinel-4c81"}`)
	if err := os.WriteFile(source, sentinel, 0o600); err != nil {
		t.Fatal(err)
	}
	before := sha256.Sum256(sentinel)

	for _, tc := range []struct {
		name       string
		mode       catalog.PermissionMode
		command    func(string) string
		editTarget func(string, string) string
	}{
		{name: "source tilde alias", mode: catalog.PermissionReadonly, command: func(string) string { return "cat ~/.grok/auth.json" }},
		{name: "copied run-home alias", mode: catalog.PermissionReadonly, command: func(string) string {
			if runtime.GOOS == "windows" {
				return "Get-Content $GROK_HOME/auth.json"
			}
			return "cat $GROK_HOME/auth.json"
		}},
		{name: "copied run-home parent listing", mode: catalog.PermissionReadonly, command: func(string) string {
			if runtime.GOOS == "windows" {
				return "Get-ChildItem $GROK_HOME"
			}
			return "ls $GROK_HOME"
		}},
		{name: "source native edit", mode: catalog.PermissionEdit, editTarget: func(source, _ string) string { return source }},
		{name: "copied native edit", mode: catalog.PermissionEdit, editTarget: func(_, destination string) string { return destination }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			runHome := t.TempDir()
			destination := filepath.Join(runHome, "auth.json")
			if err := copyInstalledOAuthFixture(source, destination); err != nil {
				t.Fatal(err)
			}
			probe := &installedChatProbe{}
			if tc.editTarget != nil {
				probe.tool = "search_replace"
				probe.input = map[string]any{
					"file_path": tc.editTarget(source, destination), "old_string": string(sentinel), "new_string": "mutated",
				}
			} else {
				probe.command = tc.command(runHome)
			}
			server := httptest.NewServer(probe)
			defer server.Close()
			config := fmt.Sprintf("[model.forge-oauth-probe]\nmodel = \"forge-oauth-probe\"\nbase_url = %q\napi_key = \"probe-only\"\napi_backend = \"chat_completions\"\ncontext_window = 200000\n", server.URL+"/v1")
			if err := os.WriteFile(filepath.Join(runHome, "config.toml"), []byte(config), 0o600); err != nil {
				t.Fatal(err)
			}
			allow, err := catalog.EffectiveBashAllow(catalog.PolicyFor(tc.mode), nil)
			if err != nil {
				t.Fatal(err)
			}
			hook, err := BashGateHookBytes(forgeBinary, allow, nil, []bashgate.SensitivePath{
				{Path: source, DenyContainingDirEnumeration: true},
				{Path: destination, DenyContainingDirEnumeration: true},
			}, runtime.GOOS)
			if err != nil {
				t.Fatal(err)
			}
			if bytes.Contains(hook, sentinel) {
				t.Fatal("installed Grok hook contained OAuth credential bytes")
			}
			hookDir := filepath.Join(runHome, "hooks")
			if err := os.MkdirAll(hookDir, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(hookDir, "forge-bash-guard.json"), hook, 0o600); err != nil {
				t.Fatal(err)
			}
			promptPath := filepath.Join(runHome, "prompt.txt")
			if err := os.WriteFile(promptPath, []byte("Run the requested local filesystem probe."), 0o600); err != nil {
				t.Fatal(err)
			}
			permissionArgs, err := catalog.EncodeGrokPermissionArgs(catalog.PolicyFor(tc.mode), nil, nil, runtime.GOOS)
			if err != nil {
				t.Fatal(err)
			}
			args := append([]string(nil), permissionArgs...)
			args = append(args, "--model", "forge-oauth-probe", "--output-format", "json", "--prompt-file", promptPath, "--no-auto-update")
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, grokPath, args...)
			cmd.Dir = t.TempDir()
			cmd.Env = replaceEnv(replaceEnv(replaceEnv(os.Environ(), "GROK_HOME", runHome), "HOME", sourceHome), "USERPROFILE", sourceHome)
			output, runErr := cmd.CombinedOutput()
			if ctx.Err() != nil {
				t.Fatalf("installed Grok OAuth local-mock probe timed out: %v", ctx.Err())
			}
			if runErr != nil {
				t.Fatalf("installed Grok OAuth local-mock probe failed: %v", runErr)
			}
			toolResult := probe.result()
			if !strings.Contains(toolResult, "Forge BashGate denied") {
				t.Fatal("installed Grok OAuth filesystem request was not denied by the Forge hook")
			}
			if bytes.Contains(output, sentinel) || strings.Contains(toolResult, string(sentinel)) || strings.Contains(probe.requestHistory(), string(sentinel)) {
				t.Fatal("installed Grok OAuth local-mock probe exposed credential bytes")
			}
			afterBytes, readErr := os.ReadFile(source)
			if readErr != nil || sha256.Sum256(afterBytes) != before {
				t.Fatalf("installed Grok OAuth source hash changed: %v", readErr)
			}
			destinationBytes, readErr := os.ReadFile(destination)
			if readErr != nil || sha256.Sum256(destinationBytes) != before {
				t.Fatalf("installed Grok copied OAuth hash changed: %v", readErr)
			}
		})
	}
}

func copyInstalledOAuthFixture(source, destination string) error {
	data, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	return os.WriteFile(destination, data, 0o600)
}

func TestInstalledGrok02106RestrictedAmpersandAndYoloBehavior(t *testing.T) {
	requireInstalledGrok(t)
	grokPath, err := exec.LookPath("grok")
	if err != nil {
		t.Skip("installed Grok is not available")
	}
	versionOutput, err := exec.Command(grokPath, "--version").CombinedOutput()
	if err != nil || !strings.Contains(string(versionOutput), "grok 0.2.106") {
		t.Skipf("installed Grok is not 0.2.106: %s (%v)", strings.TrimSpace(string(versionOutput)), err)
	}
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("rg is required for the installed safe-chain probe")
	}
	forgeBinary := buildForgeGuardBinary(t)

	cases := []struct {
		name         string
		mode         catalog.PermissionMode
		command      func(string) string
		wantReason   string
		wantSentinel bool
	}{
		{
			name: "safe allowlisted and-and chain succeeds", mode: catalog.PermissionReadonly,
			command: func(string) string { return "pwd && rg forge" },
		},
		{
			name: "single ampersand is denied before execution", mode: catalog.PermissionReadonly,
			command:    func(sentinel string) string { return "pwd & echo blocked > " + filepath.Base(sentinel) },
			wantReason: "Forge BashGate denied",
		},
		{
			name: "truncated visible prefix is denied", mode: catalog.PermissionReadonly,
			command: func(sentinel string) string {
				return "pwd" + strings.Repeat(" ", 128*1024) + "& echo truncated > " + filepath.Base(sentinel)
			},
			// The installed Windows hook transport can truncate the serialized
			// JSON itself at this size. Both that malformed form and the documented
			// toolInputTruncated=true form must produce an explicit guard denial.
			wantReason: "Forge BashGate denied",
		},
		{
			name: "clustered tree output is denied", mode: catalog.PermissionReadonly,
			command:    func(sentinel string) string { return "tree -ao" + filepath.Base(sentinel) + " ." },
			wantReason: "Forge BashGate denied",
		},
		{
			name: "clustered file magic is denied", mode: catalog.PermissionReadonly,
			command:    func(string) string { return "file -bCm ./writer.magic" },
			wantReason: "Forge BashGate denied",
		},
		{
			name: "clustered git pager is denied", mode: catalog.PermissionReadonly,
			command:    func(string) string { return "git --no-optional-locks grep -nOsh pattern" },
			wantReason: "Forge BashGate denied",
		},
		{
			name: "ripgrep helper is denied", mode: catalog.PermissionReadonly,
			command:    func(string) string { return "rg --pre writer-helper pattern ." },
			wantReason: "Forge BashGate denied",
		},
		{
			name: "cleaned proc environment alias is denied", mode: catalog.PermissionReadonly,
			command:    func(string) string { return "cat /proc/self/../self/environ" },
			wantReason: "Forge BashGate denied",
		},
		{
			name: "proc environment glob is denied", mode: catalog.PermissionReadonly,
			command:    func(string) string { return "cat /proc/self/env*" },
			wantReason: "Forge BashGate denied",
		},
		{
			name: "Windows environment provider glob is denied", mode: catalog.PermissionReadonly,
			command:    func(string) string { return "Get-Content Env:*" },
			wantReason: "Forge BashGate denied",
		},
		{
			name: "yolo remains unrestricted", mode: catalog.PermissionYolo,
			command:      func(sentinel string) string { return "echo yolo > " + filepath.Base(sentinel) },
			wantSentinel: true,
		},
		{
			name: "yolo background separator remains unrestricted", mode: catalog.PermissionYolo,
			command: func(string) string { return "sleep 1 &" },
		},
		{
			name: "yolo background sensitive read is denied", mode: catalog.PermissionYolo,
			command:    func(string) string { return "sleep 1 & cat FORGE_PROTECTED_AUTH" },
			wantReason: "Forge BashGate denied",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			workDir := t.TempDir()
			if err := os.WriteFile(filepath.Join(workDir, "probe.txt"), []byte("forge\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			sentinel := filepath.Join(workDir, "sentinel.txt")
			credentialSentinel := []byte("installed-yolo-credential-sentinel-0d91")
			credentialPath := filepath.Join(t.TempDir(), "protected-auth.json")
			if err := os.WriteFile(credentialPath, credentialSentinel, 0o600); err != nil {
				t.Fatal(err)
			}
			credentialHash := sha256.Sum256(credentialSentinel)
			command := strings.ReplaceAll(tc.command(sentinel), "FORGE_PROTECTED_AUTH", `"`+strings.ReplaceAll(credentialPath, `"`, `\"`)+`"`)
			probe := &installedChatProbe{command: command}
			server := httptest.NewServer(probe)
			defer server.Close()

			home := t.TempDir()
			config := fmt.Sprintf("[model.forge-probe]\nmodel = \"forge-probe\"\nbase_url = %q\napi_key = \"probe-only\"\napi_backend = \"chat_completions\"\ncontext_window = 200000\n", server.URL+"/v1")
			if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(config), 0o600); err != nil {
				t.Fatal(err)
			}
			policy := catalog.PolicyFor(tc.mode)
			allow, err := catalog.EffectiveBashAllow(policy, nil)
			if err != nil {
				t.Fatal(err)
			}
			hook, err := BashGateHookBytesForMode(forgeBinary, allow, nil, []bashgate.SensitivePath{{
				Path: credentialPath, DenyContainingDirEnumeration: true,
			}}, runtime.GOOS, policy.BashUnrestricted)
			if err != nil {
				t.Fatal(err)
			}
			hookDir := filepath.Join(home, "hooks")
			if err := os.MkdirAll(hookDir, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(hookDir, "forge-bash-guard.json"), hook, 0o600); err != nil {
				t.Fatal(err)
			}
			promptPath := filepath.Join(home, "prompt.txt")
			if err := os.WriteFile(promptPath, []byte("Run the requested probe command."), 0o600); err != nil {
				t.Fatal(err)
			}
			permissionArgs, err := catalog.EncodeGrokPermissionArgs(catalog.PolicyFor(tc.mode), nil, nil, runtime.GOOS)
			if err != nil {
				t.Fatal(err)
			}
			args := append([]string(nil), permissionArgs...)
			args = append(args, "--model", "forge-probe", "--output-format", "json", "--prompt-file", promptPath, "--no-auto-update")
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, grokPath, args...)
			cmd.Dir = workDir
			cmd.Env = replaceEnv(os.Environ(), "GROK_HOME", home)
			output, err := cmd.CombinedOutput()
			if ctx.Err() != nil {
				t.Fatalf("installed Grok probe timed out: %v", ctx.Err())
			}
			if err != nil {
				t.Fatalf("installed Grok probe failed: %v\n%s", err, output)
			}
			toolResult := probe.result()
			if strings.Contains(toolResult, string(credentialSentinel)) || bytes.Contains(output, credentialSentinel) {
				t.Fatal("installed Grok probe exposed credential sentinel")
			}
			if tc.wantReason != "" {
				if !strings.Contains(toolResult, tc.wantReason) {
					t.Fatalf("command was not denied for %q by the Forge hook; tool result=%s output=%s", tc.wantReason, toolResult, output)
				}
			} else if strings.Contains(toolResult, "Forge BashGate denied") {
				t.Fatalf("allowed installed probe was denied; tool result=%s output=%s", toolResult, output)
			}
			if tc.name == "safe allowlisted and-and chain succeeds" && !strings.Contains(strings.ToLower(toolResult), "forge") {
				t.Fatalf("safe && probe did not return successful rg output: %s", toolResult)
			}
			_, statErr := os.Stat(sentinel)
			if tc.wantSentinel && statErr != nil {
				t.Fatalf("unrestricted yolo command did not execute: %v; tool result=%s", statErr, toolResult)
			}
			if !tc.wantSentinel && !os.IsNotExist(statErr) {
				t.Fatalf("restricted command created sentinel: %v", statErr)
			}
			currentCredential, readErr := os.ReadFile(credentialPath)
			if readErr != nil || sha256.Sum256(currentCredential) != credentialHash {
				t.Fatalf("installed Grok credential source hash changed: %v", readErr)
			}
		})
	}
}

func TestInstalledGrok02106NativeResumeFromMinimalSnapshot(t *testing.T) {
	requireInstalledGrok(t)
	grokPath, err := exec.LookPath("grok")
	if err != nil {
		t.Skip("installed Grok is not available")
	}
	versionOutput, err := exec.Command(grokPath, "--version").CombinedOutput()
	if err != nil || !strings.Contains(string(versionOutput), "grok 0.2.106") {
		t.Skipf("installed Grok is not 0.2.106: %s (%v)", strings.TrimSpace(string(versionOutput)), err)
	}
	probe := &installedTextProbe{}
	server := httptest.NewServer(probe)
	defer server.Close()
	config := fmt.Sprintf("[model.forge-resume-probe]\nmodel = \"forge-resume-probe\"\nbase_url = %q\napi_key = \"probe-only\"\napi_backend = \"chat_completions\"\ncontext_window = 200000\n", server.URL+"/v1")
	workDir := t.TempDir()
	dataDir := t.TempDir()

	firstHome := t.TempDir()
	if err := os.WriteFile(filepath.Join(firstHome, "config.toml"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	first := runInstalledTextTurn(t, grokPath, firstHome, workDir, "first native turn", "")
	if first.SessionID == "" || first.Text != "first local response" {
		t.Fatalf("first installed native turn = %+v", first)
	}
	if err := RefreshNativeSessionSnapshot(dataDir, firstHome, first.SessionID); err != nil {
		t.Fatalf("snapshot first installed native turn: %v", err)
	}
	if err := os.RemoveAll(firstHome); err != nil {
		t.Fatalf("remove successful first installed run Home: %v", err)
	}
	if _, err := os.Stat(firstHome); !os.IsNotExist(err) {
		t.Fatalf("successful first installed run Home still exists: %v", err)
	}

	secondHome := t.TempDir()
	if err := os.WriteFile(filepath.Join(secondHome, "config.toml"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := RestoreNativeSessionSnapshot(dataDir, secondHome, first.SessionID); err != nil {
		t.Fatalf("restore installed native session into second Home: %v", err)
	}
	second := runInstalledTextTurn(t, grokPath, secondHome, workDir, "second native turn", first.SessionID)
	if second.SessionID != first.SessionID || second.Text != "second local response" {
		t.Fatalf("resumed installed native turn = %+v, first id=%q", second, first.SessionID)
	}
	if history := probe.requestHistory(); !strings.Contains(history, "first native turn") || !strings.Contains(history, "first local response") || !strings.Contains(history, "second native turn") {
		t.Fatalf("installed native resume request did not contain restored conversation history: %s", history)
	}
	if err := RefreshNativeSessionSnapshot(dataDir, secondHome, first.SessionID); err != nil {
		t.Fatalf("refresh resumed installed native session: %v", err)
	}
	if err := os.RemoveAll(secondHome); err != nil {
		t.Fatalf("remove successful second installed run Home: %v", err)
	}
	if _, err := os.Stat(secondHome); !os.IsNotExist(err) {
		t.Fatalf("successful second installed run Home still exists: %v", err)
	}
}

type installedTurnResult struct {
	Text      string `json:"text"`
	SessionID string `json:"sessionId"`
}

func runInstalledTextTurn(t *testing.T, grokPath, home, workDir, prompt, resumeID string) installedTurnResult {
	t.Helper()
	promptPath := filepath.Join(home, "prompt.txt")
	if err := os.WriteFile(promptPath, []byte(prompt), 0o600); err != nil {
		t.Fatal(err)
	}
	args := []string{
		"--permission-mode", "dontAsk", "--tools", "read_file",
		"--model", "forge-resume-probe", "--output-format", "json", "--prompt-file", promptPath, "--no-auto-update",
	}
	if resumeID != "" {
		args = append(args, "--resume", resumeID)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, grokPath, args...)
	cmd.Dir = workDir
	cmd.Env = replaceEnv(os.Environ(), "GROK_HOME", home)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	output, err := cmd.Output()
	if ctx.Err() != nil {
		t.Fatalf("installed native resume probe timed out: %v", ctx.Err())
	}
	if err != nil {
		t.Fatalf("installed native resume probe failed: %v\nstdout=%s\nstderr=%s", err, output, stderr.String())
	}
	var result installedTurnResult
	if err := json.Unmarshal(output, &result); err != nil {
		t.Fatalf("decode installed native resume output %q: %v; stderr=%s", output, err, stderr.String())
	}
	return result
}

type installedTextProbe struct {
	mu       sync.Mutex
	requests []string
}

func (p *installedTextProbe) ServeHTTP(w http.ResponseWriter, request *http.Request) {
	defer request.Body.Close()
	var body map[string]any
	if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	encoded, _ := json.Marshal(body)
	p.mu.Lock()
	p.requests = append(p.requests, string(encoded))
	p.mu.Unlock()
	content := "first local response"
	if strings.Contains(string(encoded), "second native turn") {
		content = "second local response"
	}
	stream, _ := body["stream"].(bool)
	if stream {
		w.Header().Set("Content-Type", "text/event-stream")
		writeChatSSE(w,
			map[string]any{"role": "assistant", "content": content}, nil,
			map[string]any{}, "stop",
		)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"id": "chatcmpl-resume-probe", "object": "chat.completion", "created": time.Now().Unix(), "model": "forge-resume-probe",
		"choices": []any{map[string]any{"index": 0, "message": map[string]any{"role": "assistant", "content": content}, "finish_reason": "stop"}},
		"usage":   map[string]int{"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
	})
}

func (p *installedTextProbe) requestHistory() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return strings.Join(p.requests, "\n")
}

type installedChatProbe struct {
	command string
	tool    string
	input   map[string]any

	mu         sync.Mutex
	toolResult string
	requests   []string
}

func (p *installedChatProbe) ServeHTTP(w http.ResponseWriter, request *http.Request) {
	defer request.Body.Close()
	var body struct {
		Stream   bool                     `json:"stream"`
		Messages []map[string]interface{} `json:"messages"`
	}
	if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	encodedBody, _ := json.Marshal(body)
	p.mu.Lock()
	p.requests = append(p.requests, string(encodedBody))
	p.mu.Unlock()
	hasToolResult := false
	for _, message := range body.Messages {
		if message["role"] == "tool" {
			hasToolResult = true
			encoded, _ := json.Marshal(message)
			p.mu.Lock()
			p.toolResult = string(encoded)
			p.mu.Unlock()
		}
	}
	if body.Stream {
		w.Header().Set("Content-Type", "text/event-stream")
		if hasToolResult {
			writeChatSSE(w,
				map[string]any{"role": "assistant", "content": "probe complete"}, nil,
				map[string]any{}, "stop",
			)
			return
		}
		tool, arguments := p.toolCall()
		writeChatSSE(w,
			map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{
				"index": 0, "id": "call_probe", "type": "function",
				"function": map[string]string{"name": tool, "arguments": string(arguments)},
			}}}, nil,
			map[string]any{}, "tool_calls",
		)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	message := map[string]any{"role": "assistant", "content": "probe complete"}
	finishReason := "stop"
	if !hasToolResult {
		tool, arguments := p.toolCall()
		message = map[string]any{"role": "assistant", "content": nil, "tool_calls": []any{map[string]any{
			"id": "call_probe", "type": "function",
			"function": map[string]string{"name": tool, "arguments": string(arguments)},
		}}}
		finishReason = "tool_calls"
	}
	_ = json.NewEncoder(w).Encode(map[string]any{
		"id": "chatcmpl-probe", "object": "chat.completion", "created": time.Now().Unix(), "model": "forge-probe",
		"choices": []any{map[string]any{"index": 0, "message": message, "finish_reason": finishReason}},
		"usage":   map[string]int{"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
	})
}

func (p *installedChatProbe) toolCall() (string, []byte) {
	if strings.TrimSpace(p.tool) != "" {
		arguments, _ := json.Marshal(p.input)
		return p.tool, arguments
	}
	arguments, _ := json.Marshal(map[string]string{"command": p.command, "description": "Forge installed behavior probe"})
	return "run_terminal_command", arguments
}

func (p *installedChatProbe) result() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.toolResult
}

func (p *installedChatProbe) requestHistory() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return strings.Join(p.requests, "\n")
}

func writeChatSSE(w http.ResponseWriter, pairs ...interface{}) {
	flusher, _ := w.(http.Flusher)
	for index := 0; index+1 < len(pairs); index += 2 {
		chunk := map[string]any{
			"id": "chatcmpl-probe", "object": "chat.completion.chunk", "created": time.Now().Unix(), "model": "forge-probe",
			"choices": []any{map[string]any{"index": 0, "delta": pairs[index], "finish_reason": pairs[index+1]}},
		}
		data, _ := json.Marshal(chunk)
		_, _ = fmt.Fprintf(w, "data: %s\n\n", data)
		if flusher != nil {
			flusher.Flush()
		}
	}
	_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
	if flusher != nil {
		flusher.Flush()
	}
}
