package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

type observation struct {
	Argv             []string `json:"argv"`
	Case             string   `json:"case"`
	StrictConfig     bool     `json:"strict_config"`
	IgnoreUserConfig bool     `json:"ignore_user_config"`
	ShellTool        bool     `json:"shell_tool"`
	Agent            bool     `json:"agent"`
	Sandbox          string   `json:"sandbox"`
	MCPRegistered    bool     `json:"mcp_registered"`
	MCPRequired      bool     `json:"mcp_required"`
	MCPToolExact     bool     `json:"mcp_tool_exact"`
	MCPCallError     bool     `json:"mcp_call_error"`
	MCPCallText      string   `json:"mcp_call_text"`
	MCPConfigDir     string   `json:"mcp_config_dir"`
	NativeExecuted   bool     `json:"native_executed"`
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Println("codex-cli 0.144.1-fake")
		return
	}
	args := os.Args[1:]
	configs := configValues(args)
	if hasArg(args, "--strict-config") {
		for key := range configs {
			if strings.HasPrefix(key, "unknown") {
				fmt.Fprintln(os.Stderr, "unknown configuration key")
				os.Exit(9)
			}
		}
	}
	caseName := os.Getenv("FAKE_CODEX_CASE")
	obs := observation{
		Argv: append([]string(nil), args...), Case: caseName,
		StrictConfig: hasArg(args, "--strict-config"), IgnoreUserConfig: hasArg(args, "--ignore-user-config"),
		ShellTool: configBool(configs["features.shell_tool"]), Agent: configBool(configs["features.multi_agent"]),
		Sandbox: flagValue(args, "--sandbox"),
	}
	if obs.Sandbox == "" {
		obs.Sandbox = unquote(configs["sandbox_mode"])
	}
	serverPrefix := "mcp_servers.forge_bash."
	serverCommand := unquote(configs[serverPrefix+"command"])
	serverArgs := stringArray(configs[serverPrefix+"args"])
	serverCWD := unquote(configs[serverPrefix+"cwd"])
	obs.MCPRegistered = serverCommand != "" && len(serverArgs) == 3 && serverArgs[0] == "__codex-mcp-bash" && serverArgs[1] == "--policy"
	obs.MCPRequired = configBool(configs[serverPrefix+"required"])
	tools := stringArray(configs[serverPrefix+"enabled_tools"])
	obs.MCPToolExact = len(tools) == 1 && tools[0] == "bash"
	if len(serverArgs) == 3 {
		obs.MCPConfigDir = filepath.Dir(serverArgs[2])
	}

	workDir, _ := os.Getwd()
	if serverCWD != "" {
		workDir = serverCWD
	}
	switch caseName {
	case "readonly-safe":
		command := "pwd; cat marker.txt"
		if runtime.GOOS == "windows" {
			command = "Get-Location; Get-Content marker.txt"
		}
		obs.MCPCallText, obs.MCPCallError = callMCP(serverCommand, serverArgs, serverCWD, command, workDir)
	case "readonly-unsafe":
		command := "pwd; echo changed > sentinel.txt"
		if runtime.GOOS == "windows" {
			command = "Get-Location; Set-Content sentinel.txt changed"
		}
		obs.MCPCallText, obs.MCPCallError = callMCP(serverCommand, serverArgs, serverCWD, command, workDir)
	case "edit":
		command := "touch edited.txt"
		if runtime.GOOS == "windows" {
			command = "New-Item edited.txt -ItemType File"
		}
		obs.MCPCallText, obs.MCPCallError = callMCP(serverCommand, serverArgs, serverCWD, command, workDir)
	case "yolo":
		if obs.ShellTool {
			obs.NativeExecuted = runNative(workDir)
		}
	}

	writeObservation(obs)
	if os.Getenv("FAKE_CODEX_ABNORMAL") == "1" {
		fmt.Fprintln(os.Stderr, "fake Codex abnormal exit")
		os.Exit(7)
	}
	_, _ = io.ReadAll(os.Stdin)
	emit(map[string]any{"type": "thread.started", "thread_id": "fake-codex-thread"})
	emit(map[string]any{"type": "turn.started"})
	emit(map[string]any{"type": "item.completed", "item": map[string]any{"id": "fake-message", "type": "agent_message", "text": "FAKE_CODEX_FINAL"}})
	emit(map[string]any{"type": "turn.completed", "usage": map[string]int{"input_tokens": 2, "output_tokens": 1}})
}

func callMCP(command string, args []string, cwd, shellCommand, toolCWD string) (string, bool) {
	if command == "" || len(args) != 3 {
		return "MCP registration missing", true
	}
	transcript := request(1, "initialize", map[string]any{
		"protocolVersion": "2025-06-18", "capabilities": map[string]any{},
		"clientInfo": map[string]string{"name": "codex", "version": "0.144.1"},
	}) + notification("notifications/initialized", map[string]any{}) +
		request(2, "tools/list", map[string]any{}) +
		request(3, "tools/call", map[string]any{"name": "bash", "arguments": map[string]any{"command": shellCommand, "cwd": toolCWD}})
	cmd := exec.Command(command, args...)
	cmd.Dir = cwd
	cmd.Stdin = strings.NewReader(transcript)
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = io.Discard
	if err := cmd.Run(); err != nil {
		return "MCP process failed", true
	}
	for _, line := range strings.Split(strings.TrimSpace(stdout.String()), "\n") {
		var response map[string]any
		decoder := json.NewDecoder(strings.NewReader(line))
		decoder.UseNumber()
		if decoder.Decode(&response) != nil || fmt.Sprint(response["id"]) != "3" {
			continue
		}
		result, _ := response["result"].(map[string]any)
		content, _ := result["content"].([]any)
		if len(content) != 1 {
			return "MCP result malformed", true
		}
		block, _ := content[0].(map[string]any)
		text, _ := block["text"].(string)
		isError, _ := result["isError"].(bool)
		return text, isError
	}
	return "MCP call response missing", true
}

func runNative(workDir string) bool {
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "Set-Content yolo.txt unrestricted")
	} else {
		cmd = exec.Command("/bin/sh", "-c", "printf unrestricted > yolo.txt")
	}
	cmd.Dir = workDir
	return cmd.Run() == nil
}

func configValues(args []string) map[string]string {
	out := map[string]string{}
	for i := 0; i+1 < len(args); i++ {
		if args[i] != "-c" && args[i] != "--config" {
			continue
		}
		key, value, ok := strings.Cut(args[i+1], "=")
		if ok {
			out[key] = value
		}
		i++
	}
	return out
}

func configBool(value string) bool {
	parsed, _ := strconv.ParseBool(strings.TrimSpace(value))
	return parsed
}

func unquote(value string) string {
	var result string
	if json.Unmarshal([]byte(value), &result) == nil {
		return result
	}
	return strings.Trim(value, `"`)
}

func stringArray(value string) []string {
	var result []string
	_ = json.Unmarshal([]byte(value), &result)
	return result
}

func flagValue(args []string, name string) string {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == name {
			return args[i+1]
		}
	}
	return ""
}

func hasArg(args []string, want string) bool {
	for _, arg := range args {
		if arg == want {
			return true
		}
	}
	return false
}

func request(id int, method string, params any) string {
	data, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
	return string(data) + "\n"
}

func notification(method string, params any) string {
	data, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
	return string(data) + "\n"
}

func writeObservation(obs observation) {
	path := os.Getenv("FAKE_CODEX_OBSERVATION")
	if path == "" {
		return
	}
	data, _ := json.MarshalIndent(obs, "", "  ")
	_ = os.WriteFile(path, append(data, '\n'), 0o600)
}

func emit(value any) {
	data, _ := json.Marshal(value)
	fmt.Println(string(data))
}
