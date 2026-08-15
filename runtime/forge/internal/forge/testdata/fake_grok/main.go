package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/bashgate"
)

func main() {
	args := os.Args[1:]
	promptPath := flagValue(args, "--prompt-file")
	prompt, _ := os.ReadFile(promptPath)
	grokHome := os.Getenv("GROK_HOME")
	config, _ := os.ReadFile(filepath.Join(grokHome, "config.toml"))
	credentialKeys := []string{}
	staleCredentialSeen := false
	selectedCredentialMatched := false
	unrelatedCredentialPresent := false
	for _, entry := range os.Environ() {
		key, value, ok := strings.Cut(entry, "=")
		if !ok {
			continue
		}
		upper := strings.ToUpper(key)
		if strings.HasPrefix(upper, "FORGE_GROK_") && strings.HasSuffix(upper, "_API_KEY") {
			credentialKeys = append(credentialKeys, key)
			if strings.Contains(value, "stale") {
				staleCredentialSeen = true
			}
			if upper == "FORGE_GROK_ZHIPU_CODING_API_KEY" && value == "zhipu-test-secret" {
				selectedCredentialMatched = true
			}
			if upper == "FORGE_GROK_KIMI_CODING_API_KEY" {
				unrelatedCredentialPresent = true
			}
		}
	}
	sort.Strings(credentialKeys)
	observation := map[string]any{
		"argv":                         args,
		"prompt":                       string(prompt),
		"prompt_path":                  promptPath,
		"grok_home":                    grokHome,
		"config":                       string(config),
		"credential_keys":              credentialKeys,
		"stale_credential_seen":        staleCredentialSeen,
		"auth_present":                 fileExists(filepath.Join(grokHome, "auth.json")),
		"bash_guard_present":           fileExists(filepath.Join(grokHome, "hooks", "forge-bash-guard.json")),
		"selected_credential_matched":  selectedCredentialMatched,
		"unrelated_credential_present": unrelatedCredentialPresent,
	}
	guardDecisions, guardOutputSafe := exerciseBashGate(grokHome)
	observation["guard_decisions"] = guardDecisions
	observation["guard_output_safe"] = guardOutputSafe
	sessionID := os.Getenv("FAKE_GROK_SESSION_ID")
	if sessionID == "" {
		sessionID = "fake-native-session"
	}
	resumeID := flagValue(args, "--resume")
	if resumeID != "" {
		sessionID = resumeID
	}
	restoredState, restored := restoredFakeSessionState(grokHome, resumeID)
	writtenState := os.Getenv("FAKE_GROK_STATE")
	if writtenState == "" {
		writtenState = "fake-state"
	}
	observation["resume_id"] = resumeID
	observation["restored_session_usable"] = restored
	observation["restored_state"] = restoredState
	observation["written_state"] = writtenState
	if resumeID != "" && !restored {
		writeObservation(observation)
		data, _ := json.Marshal(map[string]any{"type": "error", "message": "fake Grok resume state missing", "session_id": sessionID})
		fmt.Println(string(data))
		os.Exit(8)
	}
	if err := writeFakeSessionState(grokHome, sessionID, writtenState); err != nil {
		observation["session_write_error"] = err.Error()
		writeObservation(observation)
		data, _ := json.Marshal(map[string]any{"type": "error", "message": "fake Grok session write failed", "session_id": sessionID})
		fmt.Println(string(data))
		os.Exit(9)
	}
	writeObservation(observation)
	if os.Getenv("FAKE_GROK_HANG") == "1" {
		for {
			time.Sleep(time.Second)
		}
	}
	switch os.Getenv("FAKE_GROK_STREAM_CASE") {
	case "empty":
		return
	case "malformed":
		fmt.Println("not-json")
		return
	case "truncated":
		fmt.Print(`{"type":"end","stopReason":"EndTurn"`)
		return
	case "incomplete":
		fmt.Println(`{"type":"end"}`)
		return
	case "duplicate":
		fmt.Println(`{"type":"end","stopReason":"EndTurn"}`)
		fmt.Println(`{"type":"end","stopReason":"EndTurn"}`)
		return
	case "non-final-after-terminal":
		fmt.Println(`{"type":"end","stopReason":"EndTurn"}`)
		fmt.Println(`{"type":"thought","data":"late native record"}`)
		return
	case "failed":
		result, _ := json.Marshal(map[string]any{"type": "end", "stopReason": "Error", "sessionId": sessionID})
		fmt.Println(string(result))
		return
	case "cancelled":
		result, _ := json.Marshal(map[string]any{"type": "end", "stopReason": "Cancelled", "sessionId": sessionID})
		fmt.Println(string(result))
		return
	case "native-nonzero":
		data, _ := json.Marshal(map[string]any{"type": "error", "message": "fake Grok failure", "session_id": sessionID})
		fmt.Println(string(data))
		os.Exit(7)
	}
	exitCode, _ := strconv.Atoi(os.Getenv("FAKE_GROK_EXIT"))
	if exitCode != 0 {
		data, _ := json.Marshal(map[string]any{"type": "error", "message": "fake Grok failure", "session_id": sessionID})
		fmt.Println(string(data))
		os.Exit(exitCode)
	}
	message, _ := json.Marshal(map[string]any{"type": "text", "data": "FAKE_GROK_FINAL"})
	result, _ := json.Marshal(map[string]any{
		"type": "end", "stopReason": "EndTurn", "sessionId": sessionID,
		"usage": map[string]any{"input_tokens": 7, "output_tokens": 3},
	})
	fmt.Println(string(message))
	fmt.Println(string(result))
}

func exerciseBashGate(grokHome string) (map[string]string, bool) {
	data, err := os.ReadFile(filepath.Join(grokHome, "hooks", "forge-bash-guard.json"))
	if err != nil {
		return nil, true
	}
	var document struct {
		Hooks map[string][]struct {
			Hooks []struct {
				Env map[string]string `json:"env"`
			} `json:"hooks"`
		} `json:"hooks"`
	}
	if json.Unmarshal(data, &document) != nil || len(document.Hooks["PreToolUse"]) != 1 || len(document.Hooks["PreToolUse"][0].Hooks) != 1 {
		return map[string]string{"hook": "malformed"}, false
	}
	env := document.Hooks["PreToolUse"][0].Hooks[0].Env
	type guardInput struct {
		tool  string
		input map[string]any
		cwd   string
	}
	inputs := map[string]guardInput{
		"read_file":                   {tool: "read_file", input: map[string]any{"target_file": "/proc/self/environ"}},
		"read_file_clean_alias":       {tool: "read_file", input: map[string]any{"target_file": "/proc/self/../self/environ"}},
		"read_file_env_glob":          {tool: "read_file", input: map[string]any{"target_file": "/proc/self/env*"}},
		"read_file_pid_alias":         {tool: "read_file", input: map[string]any{"target_file": "/proc/" + strconv.Itoa(os.Getpid()) + "/environ"}},
		"read_env_provider_glob":      {tool: "read_file", input: map[string]any{"target_file": `Env:\*`}},
		"grep":                        {tool: "grep", input: map[string]any{"pattern": "anything", "path": "/proc/self/environ"}},
		"list":                        {tool: "list_dir", input: map[string]any{"target_directory": "/proc/self"}},
		"bash_proc":                   {tool: "run_terminal_cmd", input: map[string]any{"command": "cat /proc/self/environ"}},
		"bash_env_provider":           {tool: "Bash", input: map[string]any{"command": "Get-ChildItem Env:"}},
		"bash_selected_key":           {tool: "run_terminal_command", input: map[string]any{"command": "Get-Content Env:FORGE_GROK_ZHIPU_CODING_API_KEY"}},
		"bash_tree_cluster":           {tool: "run_terminal_cmd", input: map[string]any{"command": "tree -aooutput-sentinel ."}},
		"bash_file_magic":             {tool: "run_terminal_cmd", input: map[string]any{"command": "file -bCm ./writer.magic"}},
		"bash_git_pager":              {tool: "run_terminal_cmd", input: map[string]any{"command": "git --no-optional-locks grep -nOsh pattern"}},
		"bash_rg_helper":              {tool: "run_terminal_cmd", input: map[string]any{"command": "rg --pre writer-helper pattern ."}},
		"backslash_cmd_pipe":          {tool: "run_terminal_cmd", input: map[string]any{"command": `type harmless\| del victim.txt`}},
		"backslash_ps_semicolon":      {tool: "run_terminal_cmd", input: map[string]any{"command": `Get-Content harmless\; Remove-Item victim.txt`}},
		"safe_repository_read":        {tool: "read_file", input: map[string]any{"target_file": "README.md"}},
		"ordinary_safe_compound":      {tool: "run_terminal_cmd", input: map[string]any{"command": "pwd; cat README.md"}},
		"ordinary_edit":               {tool: "search_replace", input: map[string]any{"file_path": filepath.Join(cwdOrDot(), "ordinary.txt"), "old_string": "before", "new_string": "after"}},
		"compound_proc_semicolon_cat": {tool: "run_terminal_cmd", input: map[string]any{"command": "cd /proc/self; cat environ"}},
		"compound_proc_newline_read":  {tool: "run_terminal_cmd", input: map[string]any{"command": "cd /proc/self\nhead environ"}},
		"compound_proc_and_grep":      {tool: "run_terminal_cmd", input: map[string]any{"command": "cd /proc/self && grep sentinel environ"}},
		"compound_proc_and_rg":        {tool: "run_terminal_cmd", input: map[string]any{"command": "cd /proc/self && rg -a '.+'"}},
		"compound_proc_or_list":       {tool: "run_terminal_cmd", input: map[string]any{"command": "cd /proc/self || pwd; ls ."}},
		"background_unrelated":        {tool: "run_terminal_cmd", input: map[string]any{"command": "sleep 1 &"}},
	}
	sensitivePaths := guardSensitivePaths(env[bashgate.PolicyEnv])
	cwd, _ := os.Getwd()
	for index, path := range sensitivePaths {
		prefix := fmt.Sprintf("sensitive_path_%d_", index)
		parent := filepath.Dir(path)
		base := filepath.Base(path)
		quotedParent := `"` + strings.ReplaceAll(parent, `"`, `\"`) + `"`
		inputs[prefix+"read"] = guardInput{tool: "read_file", input: map[string]any{"target_file": path}}
		inputs[prefix+"grep"] = guardInput{tool: "grep", input: map[string]any{"pattern": "oauth", "path": path}}
		inputs[prefix+"grep_implicit"] = guardInput{tool: "grep", input: map[string]any{"pattern": "oauth"}, cwd: parent}
		inputs[prefix+"list_parent"] = guardInput{tool: "list_dir", input: map[string]any{"target_directory": filepath.Dir(path)}}
		inputs[prefix+"bash"] = guardInput{tool: "run_terminal_cmd", input: map[string]any{"command": `cat "` + strings.ReplaceAll(path, `"`, `""`) + `"`}}
		inputs[prefix+"bash_rg_implicit"] = guardInput{tool: "run_terminal_cmd", input: map[string]any{"command": "rg credential"}, cwd: parent}
		inputs[prefix+"bash_background"] = guardInput{tool: "run_terminal_cmd", input: map[string]any{"command": "sleep 1 & cat " + base}, cwd: parent}
		inputs[prefix+"compound_semicolon_cat"] = guardInput{tool: "run_terminal_cmd", input: map[string]any{"command": "cd " + quotedParent + "; cat " + base}}
		inputs[prefix+"compound_newline_read"] = guardInput{tool: "run_terminal_cmd", input: map[string]any{"command": "cd " + quotedParent + "\nhead " + base}}
		inputs[prefix+"compound_and_grep"] = guardInput{tool: "run_terminal_cmd", input: map[string]any{"command": "cd " + quotedParent + " && grep credential " + base}}
		inputs[prefix+"compound_or_list"] = guardInput{tool: "run_terminal_cmd", input: map[string]any{"command": "cd " + quotedParent + " || pwd; ls ."}}
		for _, editTool := range []string{"search_replace", "Edit", "Write", "MultiEdit"} {
			inputs[prefix+"edit_"+strings.ToLower(editTool)] = guardInput{tool: editTool, input: map[string]any{"file_path": path, "old_string": "credential", "new_string": "mutated"}}
		}
		if relative, err := filepath.Rel(cwd, path); err == nil {
			inputs[prefix+"relative"] = guardInput{tool: "read_file", input: map[string]any{"path": relative}}
		}
		if samePath(path, filepath.Join(grokHome, "auth.json")) {
			inputs[prefix+"home_alias"] = guardInput{tool: "read_file", input: map[string]any{"path": "$GROK_HOME/auth.json"}}
		} else if relative, ok := pathBelow(os.Getenv("HOME"), path); ok {
			inputs[prefix+"home_alias"] = guardInput{tool: "read_file", input: map[string]any{"path": "~/" + filepath.ToSlash(relative)}}
		}
	}
	for index, alias := range filepath.SplitList(os.Getenv("FAKE_GROK_SENSITIVE_ALIASES")) {
		if strings.TrimSpace(alias) == "" {
			continue
		}
		inputs[fmt.Sprintf("sensitive_alias_%d", index)] = guardInput{tool: "read_file", input: map[string]any{"path": alias}}
	}
	decisions := map[string]string{}
	outputSafe := true
	for name, request := range inputs {
		requestCWD := request.cwd
		if requestCWD == "" {
			requestCWD = cwd
		}
		payload, _ := json.Marshal(map[string]any{
			"hookEventName": "pre_tool_use", "toolName": request.tool,
			"toolInput": request.input, "toolInputTruncated": false, "cwd": requestCWD,
		})
		var output bytes.Buffer
		code := bashgate.Run(bytes.NewReader(payload), &output, env[bashgate.ModeEnv], env[bashgate.PolicyEnv])
		if code == 0 && strings.Contains(name, "_edit_") {
			if target, ok := request.input["file_path"].(string); ok {
				_ = os.WriteFile(target, []byte("guard-edit-mutation"), 0o600)
			}
		}
		var response map[string]string
		_ = json.Unmarshal(output.Bytes(), &response)
		decisions[name] = fmt.Sprintf("%s/%d", response["decision"], code)
		for _, sentinel := range []string{"zhipu-test-secret", "kimi-test-secret", "selected-secret-ref-sentinel", "oauth-source-sentinel-primary", "oauth-source-sentinel-fallback"} {
			if bytes.Contains(output.Bytes(), []byte(sentinel)) {
				outputSafe = false
			}
		}
	}
	return decisions, outputSafe
}

func cwdOrDot() string {
	cwd, err := os.Getwd()
	if err != nil {
		return "."
	}
	return cwd
}

func guardSensitivePaths(encoded string) []string {
	data, err := base64.StdEncoding.DecodeString(strings.TrimSpace(encoded))
	if err != nil {
		return nil
	}
	var policy struct {
		Paths []struct {
			Path string `json:"path"`
		} `json:"sensitive_filesystem_paths"`
	}
	if json.Unmarshal(data, &policy) != nil {
		return nil
	}
	paths := make([]string, 0, len(policy.Paths))
	for _, item := range policy.Paths {
		if strings.TrimSpace(item.Path) != "" {
			paths = append(paths, item.Path)
		}
	}
	return paths
}

func samePath(left, right string) bool {
	left, leftErr := filepath.Abs(left)
	right, rightErr := filepath.Abs(right)
	if leftErr != nil || rightErr != nil {
		return false
	}
	return strings.EqualFold(filepath.Clean(left), filepath.Clean(right))
}

func pathBelow(root, path string) (string, bool) {
	root, rootErr := filepath.Abs(strings.TrimSpace(root))
	path, pathErr := filepath.Abs(path)
	if rootErr != nil || pathErr != nil || strings.TrimSpace(root) == "" {
		return "", false
	}
	relative, err := filepath.Rel(root, path)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", false
	}
	return relative, true
}

func writeObservation(observation map[string]any) {
	if path := os.Getenv("FAKE_GROK_OBSERVATION"); path != "" {
		data, _ := json.MarshalIndent(observation, "", "  ")
		_ = os.WriteFile(path, append(data, '\n'), 0o600)
	}
}

func restoredFakeSessionState(grokHome, nativeID string) (string, bool) {
	if nativeID == "" {
		return "", false
	}
	sessionDir := findFakeSessionDir(grokHome, nativeID)
	if sessionDir == "" {
		return "", false
	}
	data, err := os.ReadFile(filepath.Join(sessionDir, "updates.jsonl"))
	if err != nil {
		return "", false
	}
	state := ""
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var update map[string]string
		if json.Unmarshal([]byte(line), &update) != nil {
			return "", false
		}
		if update["state"] != "" {
			state = update["state"]
		}
	}
	return state, state != ""
}

func writeFakeSessionState(grokHome, nativeID, state string) error {
	sessionDir := findFakeSessionDir(grokHome, nativeID)
	if sessionDir == "" {
		sessionDir = filepath.Join(grokHome, "sessions", "fake-encoded-workspace", nativeID)
	}
	if err := os.MkdirAll(sessionDir, 0o700); err != nil {
		return err
	}
	cwd, err := os.Getwd()
	if err != nil {
		return err
	}
	summary, err := json.Marshal(map[string]any{
		"info": map[string]string{"id": nativeID, "cwd": cwd}, "num_messages": 1,
	})
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(sessionDir, "summary.json"), summary, 0o600); err != nil {
		return err
	}
	update, err := json.Marshal(map[string]string{"type": "fake_native_state", "state": state})
	if err != nil {
		return err
	}
	file, err := os.OpenFile(filepath.Join(sessionDir, "updates.jsonl"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.Write(append(update, '\n')); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	chat, err := json.Marshal(map[string]string{"role": "user", "content": state})
	if err != nil {
		return err
	}
	chatFile, err := os.OpenFile(filepath.Join(sessionDir, "chat_history.jsonl"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := chatFile.Write(append(chat, '\n')); err != nil {
		_ = chatFile.Close()
		return err
	}
	return chatFile.Close()
}

func findFakeSessionDir(grokHome, nativeID string) string {
	groups, err := os.ReadDir(filepath.Join(grokHome, "sessions"))
	if err != nil {
		return ""
	}
	for _, group := range groups {
		if !group.IsDir() {
			continue
		}
		entries, err := os.ReadDir(filepath.Join(grokHome, "sessions", group.Name()))
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() && entry.Name() == nativeID {
				return filepath.Join(grokHome, "sessions", group.Name(), entry.Name())
			}
		}
	}
	return ""
}

func flagValue(args []string, flag string) string {
	for i, arg := range args {
		if arg == flag && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}
