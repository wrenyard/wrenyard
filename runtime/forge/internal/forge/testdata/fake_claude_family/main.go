package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/bashgate"
)

func main() {
	args := os.Args[1:]
	if len(args) == 1 && args[0] == "--version" {
		fmt.Println("fake-claude-family")
		return
	}
	settingsText := flagValue(args, "--settings")
	hookCommand := hookCommand(settingsText)
	caseName := os.Getenv("FAKE_CLAUDE_GATE_CASE")
	code := 0
	decision := "allow"
	hookOutputSafe := true
	if hookCommand != "" {
		if caseName == "process-error" {
			code = runMissingHookCommand(hookCommand)
			if code != 0 {
				decision = "deny"
			}
		} else {
			payload := casePayload(caseName)
			var output bytes.Buffer
			code = bashgate.Run(bytes.NewReader(payload), &output, os.Getenv(bashgate.ModeEnv), os.Getenv(bashgate.PolicyEnv))
			var response map[string]string
			_ = json.Unmarshal(output.Bytes(), &response)
			decision = response["decision"]
			hookOutputSafe = !bytes.Contains(output.Bytes(), []byte("credential-sentinel"))
		}
	} else {
		// Yolo intentionally has no restricted hook and delegates the full trust
		// boundary to the native client's bypass flag.
		decision = "unrestricted"
	}
	prompt, _ := io.ReadAll(os.Stdin)
	observation := map[string]any{
		"argv": args, "case": caseName, "decision": decision, "code": code,
		"executed": code == 0, "hook_present": hookCommand != "",
		"hook_output_safe": hookOutputSafe, "prompt_present": len(prompt) > 0,
		"client": os.Getenv(bashgate.ModeEnv),
	}
	if path := os.Getenv("FAKE_CLAUDE_OBSERVATION"); path != "" {
		data, _ := json.MarshalIndent(observation, "", "  ")
		_ = os.WriteFile(path, append(data, '\n'), 0o600)
	}
	if os.Getenv("FAKE_CLAUDE_EXIT_ON_DENY") == "1" && code != 0 {
		os.Exit(code)
	}
	message, _ := json.Marshal(map[string]any{
		"type": "assistant", "message": map[string]any{"content": []map[string]string{{"type": "text", "text": "FAKE_CLAUDE_FINAL"}}},
	})
	result, _ := json.Marshal(map[string]any{
		"type": "result", "is_error": false, "session_id": "fake-claude-session",
		"usage": map[string]int{"input_tokens": 3, "output_tokens": 2},
	})
	fmt.Println(string(message))
	fmt.Println(string(result))
}

func hookCommand(settingsText string) string {
	var settings struct {
		Hooks map[string][]struct {
			Hooks []struct {
				Command string `json:"command"`
			} `json:"hooks"`
		} `json:"hooks"`
	}
	if json.Unmarshal([]byte(settingsText), &settings) != nil || len(settings.Hooks["PreToolUse"]) != 1 || len(settings.Hooks["PreToolUse"][0].Hooks) != 1 {
		return ""
	}
	return settings.Hooks["PreToolUse"][0].Hooks[0].Command
}

func casePayload(caseName string) []byte {
	command := "cat harmless | head -n 1"
	switch caseName {
	case "safe-cat-chain":
		command = "cat harmless.txt ; cat harmless-two.txt"
	case "rm-second":
		command = "cat harmless ; rm victim"
	case "tee-second":
		command = "cat harmless | tee victim"
	case "single-ampersand":
		command = "cat harmless & head harmless"
	case "cmd-backslash-pipe":
		command = `type harmless\| del victim.txt`
	case "powershell-backslash-semicolon":
		command = `Get-Content harmless\; Remove-Item victim.txt`
	case "crlf":
		command = "cat harmless\r\nhead harmless"
	case "notesmd":
		command = "notesmd-cli list && cat README.md"
	case "clustered-tree-output":
		command = "tree -aooutput-sentinel ."
	case "clustered-file-magic":
		command = "file -bCm ./writer.magic"
	case "clustered-git-pager":
		command = "git --no-optional-locks grep -nOsh pattern"
	case "ripgrep-helper":
		command = "rg --pre writer-helper pattern ."
	case "proc-clean-alias":
		command = "cat /proc/self/../self/environ"
	case "proc-env-glob":
		command = "cat /proc/self/env*"
	case "windows-env-provider-glob":
		command = "Get-Content Env:*"
	case "malformed":
		return []byte("{")
	case "truncated":
		data, _ := json.Marshal(map[string]any{
			"hook_event_name": "PreToolUse", "tool_name": "Bash",
			"tool_input": map[string]string{"command": "cat harmless"}, "tool_input_truncated": true,
		})
		return data
	case "unknown-alias":
		data, _ := json.Marshal(map[string]any{
			"hook_event_name": "PreToolUse", "tool_name": "Shell",
			"tool_input": map[string]string{"command": "cat harmless"},
		})
		return data
	}
	data, _ := json.Marshal(map[string]any{
		"hook_event_name": "PreToolUse", "tool_name": "Bash",
		"tool_input": map[string]string{"command": command},
	})
	return data
}

func runMissingHookCommand(command string) int {
	executableToken := "%" + bashgate.ExecutableEnv + "%"
	if !strings.Contains(command, executableToken) {
		return 1
	}
	command = strings.Replace(command, executableToken, "forge-hook-does-not-exist", 1)
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("cmd.exe", "/d", "/s", "/c", command)
	} else {
		cmd = exec.Command("/bin/sh", "-c", command)
	}
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	err := cmd.Run()
	if exitErr, ok := err.(*exec.ExitError); ok {
		return exitErr.ExitCode()
	}
	if err != nil {
		return 1
	}
	return 0
}

func flagValue(args []string, flag string) string {
	for index, arg := range args {
		if arg == flag && index+1 < len(args) {
			return args[index+1]
		}
	}
	return ""
}
