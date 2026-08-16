package change

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/lifecycle/layout"
)

// Dependencies holds the small, explicit seams the apply behavior needs so the
// change package does not depend on the root forge package.
type Dependencies struct {
	// Home is the user home directory used for journal/backup layout.
	Home string
	// Redact scrubs sensitive values from journal payloads/entries.
	Redact func(any) any
}

func exists(path string) bool { _, err := os.Stat(path); return err == nil }

func normalizeNewlines(s string) string { return strings.ReplaceAll(s, "\r\n", "\n") }

func nonEmpty(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func exitCode(err error) int {
	if err == nil {
		return 0
	}
	var exitErr *exec.ExitError
	if ok := asExitError(err, &exitErr); ok {
		return exitErr.ExitCode()
	}
	return 1
}

func asExitError(err error, target **exec.ExitError) bool {
	if e, ok := err.(*exec.ExitError); ok {
		*target = e
		return true
	}
	return false
}

// Apply executes the change plan, returning a Result. When dryRun is true no
// filesystem mutation or command execution occurs and no journal is written.
func Apply(plan Plan, dryRun bool, deps Dependencies) Result {
	runID := fmt.Sprintf("%s-%d", time.Now().Format("20060102-150405"), time.Now().UnixNano()%100000000)
	entries := []map[string]interface{}{}
	succeeded := true
	for index, action := range plan.Actions {
		if dryRun {
			entries = append(entries, deps.Redact(entry(action, index, "dry_run", nil)).(map[string]interface{}))
			continue
		}
		var current map[string]interface{}
		var err error
		if action.Type == "file_write" && action.File != nil {
			current, err = applyFileWrite(*action.File, index, runID, deps)
		} else if action.Type == "command" && action.Command != nil {
			current = applyCommand(*action.Command, index)
		} else {
			err = fmt.Errorf("unsupported plan action: %s", action.Type)
		}
		if err != nil {
			succeeded = false
			current = entry(action, index, "failed", map[string]interface{}{"error": err.Error()})
		}
		current = deps.Redact(current).(map[string]interface{})
		entries = append(entries, current)
		if current["status"] == "failed" {
			succeeded = false
			break
		}
	}
	if dryRun {
		return Result{Succeeded: succeeded, Entries: entries}
	}
	journalPath := writeJournal(plan, entries, runID, succeeded, deps)
	return Result{Succeeded: succeeded, Entries: entries, JournalPath: &journalPath}
}

func applyFileWrite(action FileWrite, index int, runID string, deps Dependencies) (map[string]interface{}, error) {
	if action.Encoding == "" {
		action.Encoding = "utf-8"
	}
	backup := ""
	if exists(action.Path) {
		info, err := os.Stat(action.Path)
		if err != nil {
			return nil, err
		}
		if info.IsDir() {
			return nil, fmt.Errorf("%s is a directory", action.Path)
		}
		backupPath, backupErr := backupFile(action.Path, runID, deps)
		backup = backupPath
		err = backupErr
		if err != nil {
			return nil, err
		}
	}
	if err := os.MkdirAll(filepath.Dir(action.Path), 0o755); err != nil {
		return nil, err
	}
	if err := os.WriteFile(action.Path, []byte(normalizeNewlines(action.Content)), 0o644); err != nil {
		return nil, err
	}
	data := entry(Action{Type: "file_write", File: &action}, index, "succeeded", nil)
	if backup != "" {
		data["backup_path"] = backup
	}
	return data, nil
}

func applyCommand(action CommandAction, index int) map[string]interface{} {
	cmd := exec.Command(action.Command[0], action.Command[1:]...)
	if action.Cwd != "" {
		cmd.Dir = action.Cwd
	}
	if len(action.Env) > 0 {
		cmd.Env = os.Environ()
		for key, value := range action.Env {
			cmd.Env = append(cmd.Env, key+"="+value)
		}
	}
	out, err := cmd.CombinedOutput()
	code := exitCode(err)
	status := "succeeded"
	if code != 0 {
		status = "failed"
	}
	return entry(Action{Type: "command", Command: &action}, index, status, map[string]interface{}{"returncode": code, "stdout": string(out), "stderr": ""})
}

func actionJournal(action Action) map[string]interface{} {
	if action.Type == "file_write" && action.File != nil {
		return map[string]interface{}{"type": "file_write", "path": action.File.Path, "encoding": nonEmpty(action.File.Encoding, "utf-8"), "content": action.File.Content}
	}
	if action.Type == "command" && action.Command != nil {
		data := map[string]interface{}{"type": "command", "command": action.Command.Command}
		if action.Command.Cwd != "" {
			data["cwd"] = action.Command.Cwd
		}
		if len(action.Command.Env) > 0 {
			data["env"] = action.Command.Env
		}
		if action.Command.Description != "" {
			data["description"] = action.Command.Description
		}
		return data
	}
	return map[string]interface{}{"type": action.Type}
}

func planJournal(plan Plan) map[string]interface{} {
	actions := []map[string]interface{}{}
	for _, action := range plan.Actions {
		actions = append(actions, actionJournal(action))
	}
	return map[string]interface{}{"name": plan.Name, "actions": actions}
}

// BackupRelativePath converts an absolute path into the structure-preserving
// relative layout used inside the backup directory. Exported for callers and
// characterization tests.
func BackupRelativePath(path string) string {
	return backupRelativePath(path)
}

// PlanJournal builds the journal payload for a plan. Exported so the root
// package can reuse it for callers such as shell integration.
func PlanJournal(plan Plan) map[string]interface{} {
	return planJournal(plan)
}

func entry(action Action, index int, status string, extra map[string]interface{}) map[string]interface{} {
	data := map[string]interface{}{"index": index, "status": status, "action": actionJournal(action)}
	for key, value := range extra {
		data[key] = value
	}
	return data
}

func writeJournal(plan Plan, entries []map[string]interface{}, runID string, succeeded bool, deps Dependencies) string {
	root := filepath.Join(layout.NewPaths(deps.Home).StateDir(), "journals")
	_ = os.MkdirAll(root, 0o755)
	path := filepath.Join(root, runID+".json")
	payload := deps.Redact(map[string]interface{}{"run_id": runID, "plan": planJournal(plan), "succeeded": succeeded, "entries": entries})
	content, _ := json.MarshalIndent(payload, "", "  ")
	_ = os.WriteFile(path, append(content, '\n'), 0o644)
	return path
}

func backupFile(path, runID string, deps Dependencies) (string, error) {
	abs, _ := filepath.Abs(path)
	rel := backupRelativePath(abs)
	backup := filepath.Join(layout.NewPaths(deps.Home).StateDir(), "backups", runID, rel)
	if err := os.MkdirAll(filepath.Dir(backup), 0o755); err != nil {
		return "", err
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return backup, os.WriteFile(backup, content, 0o644)
}

func backupRelativePath(path string) string {
	clean := filepath.Clean(path)
	if volume := filepath.VolumeName(clean); volume != "" {
		rest := strings.TrimPrefix(clean, volume)
		volume = strings.NewReplacer(":", "", `\`, "_", "/", "_").Replace(strings.Trim(volume, `\/`))
		rest = strings.TrimLeft(rest, `\/`)
		if rest == "" {
			return volume
		}
		return filepath.Join(volume, rest)
	}
	return strings.TrimPrefix(clean, string(filepath.Separator))
}
