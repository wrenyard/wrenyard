package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/bashgate"
)

type observation struct {
	Argv               []string `json:"argv"`
	Case               string   `json:"case"`
	Code               int      `json:"code"`
	Decision           string   `json:"decision"`
	Executed           bool     `json:"executed"`
	HookPresent        bool     `json:"hook_present"`
	PluginExact        bool     `json:"plugin_exact"`
	BootstrapBashDeny  bool     `json:"bootstrap_bash_deny"`
	ActiveBashAllow    bool     `json:"active_bash_allow"`
	ReadonlyToolsExact bool     `json:"readonly_tools_exact"`
	EditToolsExact     bool     `json:"edit_tools_exact"`
	Pure               bool     `json:"pure"`
	Client             string   `json:"client"`
	ConfigDir          string   `json:"config_dir"`
}

func main() {
	caseName := os.Getenv("FAKE_OPENCODE_GATE_CASE")
	configDir := os.Getenv("OPENCODE_CONFIG_DIR")
	base := readObject(os.Getenv("OPENCODE_CONFIG"))
	permission, _ := base["permission"].(map[string]any)
	bashPermission, _ := permission["bash"].(map[string]any)
	bootstrapDeny := len(bashPermission) == 1 && bashPermission["*"] == "deny"
	activeBash := map[string]string{}
	_ = json.Unmarshal([]byte(os.Getenv(bashgate.OpenCodeBashPermissionEnv)), &activeBash)
	activeAllow := activeBash["*"] == "allow"

	pluginPath, pluginExact := registeredPlugin(configDir)
	pluginBytes, pluginErr := os.ReadFile(pluginPath)
	pluginExact = pluginExact && pluginErr == nil && bytes.Equal(pluginBytes, bashgate.OpenCodePluginBytes())
	hookPresent := pluginExact && os.Getenv(bashgate.ModeEnv) == string(bashgate.ClientOpenCode)
	if caseName == "hook-load-error" {
		hookPresent = false
	}
	pure := hasArg(os.Args[1:], "--pure")

	code := 0
	decision := "unrestricted"
	if hookPresent {
		decision = ""
		payload := casePayload(caseName)
		policy := os.Getenv(bashgate.PolicyEnv)
		if caseName == "missing-policy" {
			policy = ""
		}
		if caseName == "guard-process-error" || caseName == "hook-load-error" {
			code = 2
		} else {
			var output bytes.Buffer
			code = bashgate.Run(bytes.NewReader(payload), &output, os.Getenv(bashgate.ModeEnv), policy)
			var response map[string]string
			_ = json.Unmarshal(output.Bytes(), &response)
			decision = response["decision"]
		}
		if code != 0 && decision == "" {
			decision = "deny"
		}
	} else if caseName == "hook-load-error" && bootstrapDeny {
		code = 2
		decision = "deny"
	}

	readonlyExact := permission["read"] == "allow" && permission["glob"] == "allow" && permission["grep"] == "allow" &&
		permission["edit"] == nil && permission["write"] == nil && permission["task"] == nil
	editExact := permission["read"] == "allow" && permission["edit"] == "allow" && permission["write"] == "allow" && permission["task"] == nil
	observed := observation{
		Argv: os.Args[1:], Case: caseName, Code: code, Decision: decision, Executed: code == 0,
		HookPresent: hookPresent, PluginExact: pluginExact, BootstrapBashDeny: bootstrapDeny,
		ActiveBashAllow: activeAllow, ReadonlyToolsExact: readonlyExact, EditToolsExact: editExact,
		Pure: pure, Client: os.Getenv(bashgate.ModeEnv), ConfigDir: configDir,
	}
	if path := os.Getenv("FAKE_OPENCODE_OBSERVATION"); path != "" {
		data, _ := json.MarshalIndent(observed, "", "  ")
		_ = os.WriteFile(path, append(data, '\n'), 0o600)
	}
	if os.Getenv("FAKE_OPENCODE_ABNORMAL") == "1" {
		fmt.Fprintln(os.Stderr, "fake OpenCode abnormal exit")
		os.Exit(7)
	}
	fmt.Println(`{"type":"text","part":{"type":"text","text":"FAKE_OPENCODE_FINAL"}}`)
	fmt.Println(`{"type":"step_finish","part":{"type":"step-finish","tokens":{"total":2,"input":1,"output":1}}}`)
}

func readObject(path string) map[string]any {
	data, _ := os.ReadFile(path)
	object := map[string]any{}
	_ = json.Unmarshal(data, &object)
	return object
}

func registeredPlugin(configDir string) (string, bool) {
	var content struct {
		Plugin []string `json:"plugin"`
	}
	if json.Unmarshal([]byte(os.Getenv("OPENCODE_CONFIG_CONTENT")), &content) != nil || len(content.Plugin) != 1 {
		return "", false
	}
	parsed, err := url.Parse(content.Plugin[0])
	if err != nil || parsed.Scheme != "file" || parsed.Host != "" {
		return "", false
	}
	path := filepath.FromSlash(parsed.Path)
	if runtime.GOOS == "windows" && len(path) >= 3 && path[0] == filepath.Separator && path[2] == ':' {
		path = path[1:]
	}
	want := filepath.Join(configDir, "forge-bashgate.js")
	return path, filepath.Clean(path) == filepath.Clean(want)
}

func casePayload(caseName string) []byte {
	command := "pwd && rg forge"
	toolName := "bash"
	truncated := false
	switch caseName {
	case "safe-semicolon":
		command = "pwd ; rg forge"
	case "safe-pipe":
		command = "cat go.mod | head -n 1"
	case "safe-crlf":
		command = "pwd\r\nrg forge"
	case "safe-cr":
		command = "pwd\rrg forge"
	case "safe-lf":
		command = "pwd\nrg forge"
	case "unsafe-and":
		command = "pwd && tee victim.txt"
	case "unsafe-second":
		command = "pwd ; tee victim.txt"
	case "unsafe-pipe":
		command = "cat go.mod | tee victim.txt"
	case "single-ampersand":
		command = "pwd & rm victim.txt"
	case "clustered-unsafe-option":
		command = "tree -aooutput-sentinel ."
	case "notesmd":
		command = "notesmd-cli list && rg forge"
	case "malformed":
		return []byte("{")
	case "truncated":
		truncated = true
	case "unknown-alias":
		toolName = "Shell"
	}
	payload, _ := json.Marshal(map[string]any{
		"hook_event_name": "PreToolUse", "tool_name": toolName,
		"tool_input": map[string]string{"command": command}, "tool_input_truncated": truncated,
		"cwd": os.Getenv("PWD"),
	})
	return payload
}

func hasArg(args []string, want string) bool {
	for _, arg := range args {
		if strings.EqualFold(arg, want) {
			return true
		}
	}
	return false
}
