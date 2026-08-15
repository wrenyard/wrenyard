package execution

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/bashgate"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/driver"
)

const (
	codexMCPMaxMessageBytes = 1 << 20
	codexMCPMaxCommandBytes = 64 << 10
	codexMCPOutputBytes     = 64 << 10
)

var supportedCodexMCPProtocolVersions = map[string]bool{
	"2024-11-05": true,
	"2025-03-26": true,
	"2025-06-18": true,
	"2025-11-25": true,
}

type codexMCPEnvelope struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type codexMCPResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   any             `json:"error,omitempty"`
}

type codexMCPServer struct {
	policy string
	out    io.Writer
	errOut io.Writer

	writeMu  sync.Mutex
	active   map[string]context.CancelFunc
	activeMu sync.Mutex
	wait     sync.WaitGroup
	ready    bool
}

// RunCodexMCPServer serves the minimal JSON-RPC lifecycle used by Codex's
// stdio MCP client. The policy must already exist as a per-run Forge resource;
// every startup, protocol, validation, and authorization failure is closed.
func RunCodexMCPServer(ctx context.Context, input io.Reader, output, errorOutput io.Writer, policyPath string) int {
	policy, ok := readCodexMCPPolicy(policyPath)
	if !ok {
		fmt.Fprintln(errorOutput, "forge: Codex MCP policy is unavailable")
		return 2
	}
	server := &codexMCPServer{
		policy: policy,
		out:    output,
		errOut: errorOutput,
		active: map[string]context.CancelFunc{},
	}
	return server.run(ctx, input)
}

func readCodexMCPPolicy(path string) (string, bool) {
	path = strings.TrimSpace(path)
	if path == "" || strings.ContainsAny(path, "\x00\r\n") || !filepath.IsAbs(path) {
		return "", false
	}
	file, err := os.Open(filepath.Clean(path))
	if err != nil {
		return "", false
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > codexMCPMaxMessageBytes {
		return "", false
	}
	data, err := io.ReadAll(io.LimitReader(file, codexMCPMaxMessageBytes+1))
	if err != nil || len(data) == 0 || len(data) > codexMCPMaxMessageBytes {
		return "", false
	}
	policy := strings.TrimSpace(string(data))
	if _, allowed := bashgate.AuthorizeCommand(bashgate.ClientCodex, policy, "pwd", mustCurrentDirectory()); !allowed {
		return "", false
	}
	return policy, true
}

func mustCurrentDirectory() string {
	cwd, _ := os.Getwd()
	return cwd
}

func (s *codexMCPServer) run(ctx context.Context, input io.Reader) int {
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 0, 64*1024), codexMCPMaxMessageBytes)
	for scanner.Scan() {
		if err := ctx.Err(); err != nil {
			s.cancelAll()
			s.wait.Wait()
			return 1
		}
		line := append([]byte(nil), scanner.Bytes()...)
		if len(line) == 0 || len(line) > codexMCPMaxMessageBytes {
			s.writeError(json.RawMessage("null"), -32700, "invalid JSON-RPC message")
			continue
		}
		var request codexMCPEnvelope
		if !decodeStrictJSON(line, &request) || request.JSONRPC != "2.0" || strings.TrimSpace(request.Method) == "" {
			s.writeError(json.RawMessage("null"), -32600, "invalid JSON-RPC request")
			continue
		}
		s.handle(ctx, request)
	}
	if scanner.Err() != nil {
		s.writeError(json.RawMessage("null"), -32700, "invalid JSON-RPC message")
		s.cancelAll()
		s.wait.Wait()
		return 2
	}
	s.wait.Wait()
	return 0
}

func (s *codexMCPServer) handle(parent context.Context, request codexMCPEnvelope) {
	switch request.Method {
	case "initialize":
		if !validCodexMCPRequestID(request.ID) {
			s.writeError(json.RawMessage("null"), -32600, "invalid JSON-RPC request")
			return
		}
		var params struct {
			ProtocolVersion string                     `json:"protocolVersion"`
			Capabilities    map[string]json.RawMessage `json:"capabilities"`
			ClientInfo      struct {
				Name    string `json:"name"`
				Title   string `json:"title,omitempty"`
				Version string `json:"version"`
			} `json:"clientInfo"`
			Meta json.RawMessage `json:"_meta,omitempty"`
		}
		if !decodeStrictJSON(request.Params, &params) || !supportedCodexMCPProtocolVersions[params.ProtocolVersion] || strings.TrimSpace(params.ClientInfo.Name) == "" || strings.TrimSpace(params.ClientInfo.Version) == "" || !validJSONObject(params.Meta) {
			s.writeError(request.ID, -32602, "invalid initialize parameters")
			return
		}
		s.ready = false
		s.writeResult(request.ID, map[string]any{
			"protocolVersion": params.ProtocolVersion,
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo":      map[string]string{"name": "forge-restricted-bash", "version": "0.7.14"},
			"instructions":    "Use the forge_bash server's bash tool for complete shell commands; it enforces the active Forge BashGate policy.",
		})
	case "notifications/initialized":
		if len(request.ID) != 0 || !validEmptyParams(request.Params) {
			return
		}
		s.ready = true
	case "tools/list":
		if !s.ready || !validCodexMCPRequestID(request.ID) || !validToolsListParams(request.Params) {
			s.writeError(requestIDOrNull(request.ID), -32602, "invalid tools/list request")
			return
		}
		s.writeResult(request.ID, map[string]any{"tools": []any{map[string]any{
			"name":        driver.CodexMCPToolName,
			"title":       "Forge restricted Bash",
			"description": "Execute one complete command after Forge BashGate authorization.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"command": map[string]string{"type": "string", "description": "One complete shell command."},
					"cwd":     map[string]string{"type": "string", "description": "Optional command working directory."},
				},
				"required":             []string{"command"},
				"additionalProperties": false,
			},
		}}})
	case "tools/call":
		s.handleToolCall(parent, request)
	case "notifications/cancelled":
		s.handleCancellation(request)
	default:
		if validCodexMCPRequestID(request.ID) {
			s.writeError(request.ID, -32601, "method not found")
		}
	}
}

func (s *codexMCPServer) handleToolCall(parent context.Context, request codexMCPEnvelope) {
	if !s.ready || !validCodexMCPRequestID(request.ID) {
		s.writeError(requestIDOrNull(request.ID), -32602, "invalid tools/call request")
		return
	}
	var params struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
		Meta      json.RawMessage `json:"_meta,omitempty"`
	}
	if !decodeStrictJSON(request.Params, &params) || params.Name != driver.CodexMCPToolName || !validJSONObject(params.Meta) {
		s.writeError(request.ID, -32602, "invalid tools/call parameters")
		return
	}
	var arguments struct {
		Command string  `json:"command"`
		CWD     *string `json:"cwd,omitempty"`
	}
	if !decodeStrictJSON(params.Arguments, &arguments) || strings.TrimSpace(arguments.Command) == "" || len(arguments.Command) > codexMCPMaxCommandBytes {
		s.writeError(request.ID, -32602, "invalid Bash tool arguments")
		return
	}
	cwd, ok := resolveCodexMCPWorkingDirectory(arguments.CWD)
	if !ok {
		s.writeError(request.ID, -32602, "invalid Bash tool arguments")
		return
	}
	if reason, allowed := bashgate.AuthorizeCommand(bashgate.ClientCodex, s.policy, arguments.Command, cwd); !allowed {
		s.writeToolResult(request.ID, reason, true)
		return
	}

	key := string(request.ID)
	callCtx, cancel := context.WithCancel(parent)
	s.activeMu.Lock()
	if _, duplicate := s.active[key]; duplicate {
		s.activeMu.Unlock()
		cancel()
		s.writeError(request.ID, -32600, "duplicate Bash tool call id")
		return
	}
	s.active[key] = cancel
	s.activeMu.Unlock()
	s.wait.Add(1)
	go func() {
		defer s.wait.Done()
		text, isError := executeCodexMCPCommand(callCtx, arguments.Command, cwd)
		s.activeMu.Lock()
		delete(s.active, key)
		s.activeMu.Unlock()
		cancel()
		s.writeToolResult(request.ID, text, isError)
	}()
}

func (s *codexMCPServer) handleCancellation(request codexMCPEnvelope) {
	if len(request.ID) != 0 {
		return
	}
	var params struct {
		RequestID json.RawMessage `json:"requestId"`
		Reason    string          `json:"reason,omitempty"`
	}
	if !decodeStrictJSON(request.Params, &params) || !validCodexMCPRequestID(params.RequestID) {
		return
	}
	s.activeMu.Lock()
	cancel := s.active[string(params.RequestID)]
	s.activeMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (s *codexMCPServer) cancelAll() {
	s.activeMu.Lock()
	defer s.activeMu.Unlock()
	for _, cancel := range s.active {
		cancel()
	}
}

func (s *codexMCPServer) writeResult(id json.RawMessage, result any) {
	s.write(codexMCPResponse{JSONRPC: "2.0", ID: id, Result: result})
}

func (s *codexMCPServer) writeError(id json.RawMessage, code int, message string) {
	s.write(codexMCPResponse{JSONRPC: "2.0", ID: requestIDOrNull(id), Error: map[string]any{"code": code, "message": message}})
}

func (s *codexMCPServer) writeToolResult(id json.RawMessage, text string, isError bool) {
	s.writeResult(id, map[string]any{
		"content": []any{map[string]string{"type": "text", "text": boundedUTF8(text, codexMCPOutputBytes*2)}},
		"isError": isError,
	})
}

func (s *codexMCPServer) write(response codexMCPResponse) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	data, err := json.Marshal(response)
	if err != nil || len(data) > codexMCPMaxMessageBytes {
		data = []byte(`{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"bounded protocol response failure"}}`)
	}
	_, _ = s.out.Write(append(data, '\n'))
}

func executeCodexMCPCommand(ctx context.Context, command, cwd string) (string, bool) {
	// A cancellation notification can arrive after the call is registered but
	// before its worker goroutine is scheduled. Do not create a process in that
	// state: starting and immediately killing a not-yet-initialized Windows
	// shell makes process-tree termination unnecessarily racy.
	if ctx.Err() != nil {
		return "Forge restricted Bash command cancelled", true
	}
	var shell string
	var args []string
	if runtime.GOOS == "windows" {
		shell = "powershell.exe"
		args = []string{"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command}
	} else {
		shell = "/bin/sh"
		args = []string{"-c", command}
	}
	cmd := exec.Command(shell, args...)
	cmd.Dir = cwd
	cmd.Env = driver.BuildChildEnvForPermission(nil, catalog.PermissionReadonly)
	stdout := &boundedMCPBuffer{limit: codexMCPOutputBytes}
	stderr := &boundedMCPBuffer{limit: codexMCPOutputBytes}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	hideCommandWindow(cmd)
	if ctx.Err() != nil {
		return "Forge restricted Bash command cancelled", true
	}
	if err := cmd.Start(); err != nil {
		return "Forge restricted Bash failed to start", true
	}
	waitDone := make(chan error, 1)
	go func() { waitDone <- cmd.Wait() }()
	var waitErr error
	select {
	case waitErr = <-waitDone:
	case <-ctx.Done():
		if err := terminateWorkerTreeNow(cmd, waitDone); err != nil {
			return "Forge restricted Bash cancellation failed", true
		}
		return "Forge restricted Bash command cancelled", true
	}
	exitCode := 0
	if waitErr != nil {
		exitCode = 1
		var exitErr *exec.ExitError
		if errors.As(waitErr, &exitErr) {
			exitCode = exitErr.ExitCode()
		}
	}
	var result strings.Builder
	fmt.Fprintf(&result, "exit_code: %d", exitCode)
	if stdout.Len() > 0 {
		result.WriteString("\nstdout:\n")
		result.WriteString(stdout.String())
	}
	if stderr.Len() > 0 {
		result.WriteString("\nstderr:\n")
		result.WriteString(stderr.String())
	}
	if stdout.truncated || stderr.truncated {
		result.WriteString("\n[output truncated]")
	}
	return boundedUTF8(result.String(), codexMCPOutputBytes*2), waitErr != nil
}

type boundedMCPBuffer struct {
	data      []byte
	limit     int
	truncated bool
}

func (b *boundedMCPBuffer) Write(p []byte) (int, error) {
	written := len(p)
	remaining := b.limit - len(b.data)
	if remaining > 0 {
		if len(p) > remaining {
			p = p[:remaining]
		}
		b.data = append(b.data, p...)
	}
	if written > remaining {
		b.truncated = true
	}
	return written, nil
}

func (b *boundedMCPBuffer) Len() int { return len(b.data) }

func (b *boundedMCPBuffer) String() string {
	return strings.ToValidUTF8(string(b.data), "\uFFFD")
}

func boundedUTF8(value string, limit int) string {
	value = strings.ToValidUTF8(value, "\uFFFD")
	if limit <= 0 || len(value) <= limit {
		return value
	}
	end := limit
	for end > 0 && value[end]&0xC0 == 0x80 {
		end--
	}
	return value[:end]
}

func resolveCodexMCPWorkingDirectory(raw *string) (string, bool) {
	value := ""
	if raw != nil {
		value = strings.TrimSpace(*raw)
		if value == "" || strings.ContainsAny(value, "\x00\r\n") {
			return "", false
		}
	}
	if value == "" {
		var err error
		value, err = os.Getwd()
		if err != nil {
			return "", false
		}
	}
	absolute, err := filepath.Abs(value)
	if err != nil {
		return "", false
	}
	info, err := os.Stat(absolute)
	return filepath.Clean(absolute), err == nil && info.IsDir()
}

func decodeStrictJSON(data []byte, target any) bool {
	if len(data) == 0 {
		return false
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	decoder.UseNumber()
	if err := decoder.Decode(target); err != nil {
		return false
	}
	return decoder.Decode(&struct{}{}) == io.EOF
}

func validCodexMCPRequestID(id json.RawMessage) bool {
	if len(id) == 0 || string(id) == "null" {
		return false
	}
	var value any
	decoder := json.NewDecoder(strings.NewReader(string(id)))
	decoder.UseNumber()
	if decoder.Decode(&value) != nil || decoder.Decode(&struct{}{}) != io.EOF {
		return false
	}
	switch value.(type) {
	case string, json.Number:
		return true
	default:
		return false
	}
}

func requestIDOrNull(id json.RawMessage) json.RawMessage {
	if validCodexMCPRequestID(id) {
		return id
	}
	return json.RawMessage("null")
}

func validJSONObject(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return true
	}
	var object map[string]json.RawMessage
	return decodeStrictJSON(raw, &object) && object != nil
}

func validEmptyParams(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return true
	}
	var object map[string]json.RawMessage
	return decodeStrictJSON(raw, &object) && len(object) == 0
}

func validToolsListParams(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return true
	}
	var params struct {
		Cursor string          `json:"cursor,omitempty"`
		Meta   json.RawMessage `json:"_meta,omitempty"`
	}
	return decodeStrictJSON(raw, &params) && params.Cursor == "" && validJSONObject(params.Meta)
}
