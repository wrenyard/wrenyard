package execution

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/bashgate"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/driver"
)

func TestCodexMCPHandshakeListAndSafeCompoundCall(t *testing.T) {
	workDir := t.TempDir()
	policyPath := writeCodexMCPTestPolicy(t, catalog.PermissionReadonly, nil)
	transcript := codexMCPInitializeTranscript() +
		codexMCPRequest(2, "tools/list", map[string]any{}) +
		codexMCPRequest(3, "tools/call", map[string]any{
			"name":      driver.CodexMCPToolName,
			"arguments": map[string]any{"command": "pwd; pwd", "cwd": workDir},
		})
	code, responses, stderr := runCodexMCPTranscript(t, policyPath, transcript)
	if code != 0 || stderr != "" {
		t.Fatalf("server code=%d stderr=%q responses=%s", code, stderr, responses)
	}
	initialize := codexMCPResponseForID(t, responses, "1")
	result := initialize["result"].(map[string]any)
	if result["protocolVersion"] != "2025-06-18" || !strings.Contains(result["instructions"].(string), "forge_bash") {
		t.Fatalf("initialize result = %#v", result)
	}
	list := codexMCPResponseForID(t, responses, "2")["result"].(map[string]any)
	tools := list["tools"].([]any)
	if len(tools) != 1 || tools[0].(map[string]any)["name"] != driver.CodexMCPToolName {
		t.Fatalf("tools/list = %#v", list)
	}
	call := codexMCPResponseForID(t, responses, "3")["result"].(map[string]any)
	if call["isError"] != false {
		t.Fatalf("safe call result = %#v", call)
	}
	text := codexMCPResultText(t, call)
	if !strings.Contains(text, "exit_code: 0") || strings.Count(strings.ToLower(text), strings.ToLower(filepath.Base(filepath.Clean(workDir)))) < 2 {
		t.Fatalf("safe compound output = %q", text)
	}
}

func TestCodexMCPUnsafeSegmentAndMalformedArgumentsNeverExecute(t *testing.T) {
	workDir := t.TempDir()
	sentinel := filepath.Join(workDir, "preserve.txt")
	if err := os.WriteFile(sentinel, []byte("preserve\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	policyPath := writeCodexMCPTestPolicy(t, catalog.PermissionEdit, nil)
	unsafe := "pwd; echo changed > preserve.txt"
	mutation := "touch malformed.txt"
	if runtime.GOOS == "windows" {
		unsafe = "pwd; Set-Content preserve.txt changed"
		mutation = "New-Item malformed.txt"
	}
	transcript := codexMCPInitializeTranscript() +
		codexMCPRequest(2, "tools/call", map[string]any{
			"name":      driver.CodexMCPToolName,
			"arguments": map[string]any{"command": unsafe, "cwd": workDir},
		}) +
		codexMCPRequest(3, "tools/call", map[string]any{
			"name":      driver.CodexMCPToolName,
			"arguments": map[string]any{"command": mutation, "cwd": workDir, "unknown": true},
		})
	code, responses, _ := runCodexMCPTranscript(t, policyPath, transcript)
	if code != 0 {
		t.Fatalf("server code=%d responses=%s", code, responses)
	}
	denied := codexMCPResponseForID(t, responses, "2")["result"].(map[string]any)
	if denied["isError"] != true || !strings.Contains(codexMCPResultText(t, denied), "EffectiveBashAllow") {
		t.Fatalf("unsafe call = %#v", denied)
	}
	malformed := codexMCPResponseForID(t, responses, "3")
	if _, ok := malformed["error"]; !ok {
		t.Fatalf("unknown argument did not produce protocol error: %#v", malformed)
	}
	if data, err := os.ReadFile(sentinel); err != nil || string(data) != "preserve\n" {
		t.Fatalf("unsafe segment changed sentinel: data=%q err=%v", data, err)
	}
	if _, err := os.Stat(filepath.Join(workDir, "malformed.txt")); !os.IsNotExist(err) {
		t.Fatalf("malformed request executed mutation: %v", err)
	}
}

func TestCodexMCPMalformedOversizedAndMissingPolicyFailClosed(t *testing.T) {
	policyPath := writeCodexMCPTestPolicy(t, catalog.PermissionReadonly, nil)
	code, output, _ := runCodexMCPTranscript(t, policyPath, "not-json\n")
	if code != 0 || !strings.Contains(output, `"code":-32600`) {
		t.Fatalf("malformed request code=%d output=%q", code, output)
	}
	oversized := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"bash","arguments":{"command":"pwd","padding":"` + strings.Repeat("x", codexMCPMaxMessageBytes) + `"}}}` + "\n"
	code, output, _ = runCodexMCPTranscript(t, policyPath, oversized)
	if code != 2 || !strings.Contains(output, `"code":-32700`) {
		t.Fatalf("oversized request code=%d output prefix=%q", code, boundedUTF8(output, 300))
	}
	var stdout, stderr bytes.Buffer
	missing := filepath.Join(t.TempDir(), "missing.policy")
	if got := RunCodexMCPServer(context.Background(), strings.NewReader(codexMCPInitializeTranscript()), &stdout, &stderr, missing); got != 2 || stdout.Len() != 0 || !strings.Contains(stderr.String(), "policy is unavailable") || strings.Contains(stderr.String(), missing) {
		t.Fatalf("missing policy code=%d stdout=%q stderr=%q", got, stdout.String(), stderr.String())
	}
}

func TestCodexMCPCancellationKillsTreeBeforeSentinel(t *testing.T) {
	workDir := t.TempDir()
	sentinel := filepath.Join(workDir, "cancelled.txt")
	var command string
	var capRule catalog.BashRule
	if runtime.GOOS == "windows" {
		command = "ping.exe -n 30 127.0.0.1; New-Item cancelled.txt"
		capRule = catalog.BashRule{Pattern: "ping.exe *"}
	} else {
		command = "sleep 30; touch cancelled.txt"
		capRule = catalog.BashRule{Pattern: "sleep *"}
	}
	policyPath := writeCodexMCPTestPolicy(t, catalog.PermissionEdit, []catalog.BashRule{capRule})
	transcript := codexMCPInitializeTranscript() +
		codexMCPRequest(8, "tools/call", map[string]any{
			"name":      driver.CodexMCPToolName,
			"arguments": map[string]any{"command": command, "cwd": workDir},
		}) +
		codexMCPNotification("notifications/cancelled", map[string]any{"requestId": 8, "reason": "test cancellation"})
	start := time.Now()
	code, responses, _ := runCodexMCPTranscript(t, policyPath, transcript)
	if code != 0 || time.Since(start) > 10*time.Second {
		t.Fatalf("cancel server code=%d elapsed=%s responses=%s", code, time.Since(start), responses)
	}
	call := codexMCPResponseForID(t, responses, "8")["result"].(map[string]any)
	if call["isError"] != true || !strings.Contains(strings.ToLower(codexMCPResultText(t, call)), "cancel") {
		t.Fatalf("cancelled result = %#v", call)
	}
	if _, err := os.Stat(sentinel); !os.IsNotExist(err) {
		t.Fatalf("cancelled command reached sentinel: %v", err)
	}
}

func TestCodexMCPOutputAndErrorAreBounded(t *testing.T) {
	workDir := t.TempDir()
	largePath := filepath.Join(workDir, "large.txt")
	if err := os.WriteFile(largePath, bytes.Repeat([]byte("x"), codexMCPOutputBytes*3), 0o600); err != nil {
		t.Fatal(err)
	}
	policyPath := writeCodexMCPTestPolicy(t, catalog.PermissionReadonly, nil)
	stdoutCommand := "cat large.txt"
	missing := make([]string, 0, 2000)
	for i := 0; i < cap(missing); i++ {
		missing = append(missing, "cat "+fmt.Sprintf("missing-%04d", i))
	}
	stderrCommand := strings.Join(missing, "; ")
	if runtime.GOOS == "windows" {
		stdoutCommand = "Get-Content -Raw large.txt"
		for i := range missing {
			missing[i] = "Get-Content " + fmt.Sprintf("missing-%04d", i)
		}
		stderrCommand = strings.Join(missing, "; ")
	}
	transcript := codexMCPInitializeTranscript() +
		codexMCPRequest(2, "tools/call", map[string]any{"name": driver.CodexMCPToolName, "arguments": map[string]any{"command": stdoutCommand, "cwd": workDir}}) +
		codexMCPRequest(3, "tools/call", map[string]any{"name": driver.CodexMCPToolName, "arguments": map[string]any{"command": stderrCommand, "cwd": workDir}})
	code, responses, _ := runCodexMCPTranscript(t, policyPath, transcript)
	if code != 0 || len(responses) > codexMCPMaxMessageBytes {
		t.Fatalf("bounded server code=%d response bytes=%d", code, len(responses))
	}
	for _, id := range []string{"2", "3"} {
		result := codexMCPResponseForID(t, responses, id)["result"].(map[string]any)
		text := codexMCPResultText(t, result)
		windowsLaunchBound := runtime.GOOS == "windows" && id == "3" && strings.Contains(text, "failed to start")
		if len(text) > codexMCPOutputBytes*2 || (!strings.Contains(text, "[output truncated]") && !windowsLaunchBound) {
			t.Fatalf("response %s bounds len=%d tail=%q", id, len(text), boundedUTF8(text, 200))
		}
	}
}

func writeCodexMCPTestPolicy(t *testing.T, mode catalog.PermissionMode, capBash []catalog.BashRule) string {
	t.Helper()
	allow, err := catalog.EffectiveBashAllow(catalog.PolicyFor(mode), capBash)
	if err != nil {
		t.Fatal(err)
	}
	dialect := catalog.BashShellPOSIX
	if runtime.GOOS == "windows" {
		dialect = catalog.BashShellPowerShell
	}
	encoded, err := bashgate.EncodePolicyForShell(bashgate.ClientCodex, allow, nil, nil, dialect)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "bashgate.policy")
	if err := os.WriteFile(path, []byte(encoded+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func codexMCPInitializeTranscript() string {
	return codexMCPRequest(1, "initialize", map[string]any{
		"protocolVersion": "2025-06-18",
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]string{"name": "codex", "version": "0.144.1"},
	}) + codexMCPNotification("notifications/initialized", map[string]any{})
}

func codexMCPRequest(id int, method string, params any) string {
	data, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
	return string(data) + "\n"
}

func codexMCPNotification(method string, params any) string {
	data, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
	return string(data) + "\n"
}

func runCodexMCPTranscript(t *testing.T, policyPath, transcript string) (int, string, string) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	code := RunCodexMCPServer(context.Background(), strings.NewReader(transcript), &stdout, &stderr, policyPath)
	return code, stdout.String(), stderr.String()
}

func codexMCPResponseForID(t *testing.T, transcript, id string) map[string]any {
	t.Helper()
	for _, line := range strings.Split(strings.TrimSpace(transcript), "\n") {
		var response map[string]any
		decoder := json.NewDecoder(strings.NewReader(line))
		decoder.UseNumber()
		if err := decoder.Decode(&response); err != nil {
			t.Fatal(err)
		}
		if fmt.Sprint(response["id"]) == id {
			return response
		}
	}
	t.Fatalf("response id %s not found in %s", id, transcript)
	return nil
}

func codexMCPResultText(t *testing.T, result map[string]any) string {
	t.Helper()
	content := result["content"].([]any)
	if len(content) != 1 {
		t.Fatalf("tool content = %#v", content)
	}
	return content[0].(map[string]any)["text"].(string)
}
