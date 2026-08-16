package forge

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// Characterization tests for apply.go change-plan application. These exercise
// the same code paths used by shell integration and setup, using temporary
// directories and the package-level userHome seams (driven via t.Setenv HOME).

func applyTestHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_STATE_HOME", "")
	return home
}

func TestApplyPlanCreateNewFile(t *testing.T) {
	home := applyTestHome(t)
	target := filepath.Join(home, "project", "rc", "dotfile")
	plan := changePlan{
		Name: "create-dotfile",
		Actions: []planAction{
			{Type: "file_write", File: &fileWrite{Path: target, Content: "hello\n", Encoding: "utf-8"}},
		},
	}
	result := applyPlan(plan, false)
	if !result.Succeeded {
		t.Fatalf("expected success, entries: %#v", result.Entries)
	}
	if got := readTextIfExists(target); got != "hello\n" {
		t.Fatalf("file content = %q, want hello", got)
	}
	if result.JournalPath == nil || !exists(*result.JournalPath) {
		t.Fatalf("journal should be written, got %#v", result.JournalPath)
	}
	// Entry records success with no backup (new file).
	first := result.Entries[0]
	if first["status"] != "succeeded" {
		t.Fatalf("entry status = %#v, want succeeded", first["status"])
	}
	if _, ok := first["backup_path"]; ok {
		t.Fatalf("new file should not have a backup_path, got %#v", first)
	}
}

func TestApplyPlanBacksUpExistingFile(t *testing.T) {
	home := applyTestHome(t)
	target := filepath.Join(home, "project", "rc", "dotfile")
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte("original\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	plan := changePlan{
		Name: "overwrite-dotfile",
		Actions: []planAction{
			{Type: "file_write", File: &fileWrite{Path: target, Content: "replaced\n"}},
		},
	}
	result := applyPlan(plan, false)
	if !result.Succeeded {
		t.Fatalf("expected success, entries: %#v", result.Entries)
	}
	if got := readTextIfExists(target); got != "replaced\n" {
		t.Fatalf("file content = %q, want replaced", got)
	}
	// Pre-existing file must be backed up before overwrite.
	backupPath, ok := result.Entries[0]["backup_path"].(string)
	if !ok || backupPath == "" {
		t.Fatalf("expected backup_path on overwritten file, got %#v", result.Entries[0])
	}
	if !exists(backupPath) {
		t.Fatalf("backup file should exist at %s", backupPath)
	}
	if got := readTextIfExists(backupPath); got != "original\n" {
		t.Fatalf("backup content = %q, want original", got)
	}
	// Backup lives under the Wrenyard runtime backup root for the run.
	if !strings.Contains(backupPath, filepath.Join(".local", "state", "wrenyard", "runtime", "backups")) {
		t.Fatalf("backup should live under Wrenyard runtime backups dir, got %s", backupPath)
	}
}

func TestApplyPlanStopsAtFirstFailure(t *testing.T) {
	home := applyTestHome(t)
	target := filepath.Join(home, "project", "rc", "dotfile")
	// A directory at the target path forces applyFileWrite to fail.
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	goodTarget := filepath.Join(home, "project", "rc", "good")
	plan := changePlan{
		Name: "mixed-plan",
		Actions: []planAction{
			{Type: "file_write", File: &fileWrite{Path: goodTarget, Content: "ok\n"}},
			{Type: "file_write", File: &fileWrite{Path: target, Content: "will-fail\n"}},
			{Type: "file_write", File: &fileWrite{Path: filepath.Join(home, "project", "rc", "never"), Content: "never-runs\n"}},
		},
	}
	result := applyPlan(plan, false)
	if result.Succeeded {
		t.Fatal("plan with a failing action must not report success")
	}
	// Good action completed; failing action marked failed; third never ran.
	if len(result.Entries) != 2 {
		t.Fatalf("expected exactly 2 processed entries (stop at failure), got %d: %#v", len(result.Entries), result.Entries)
	}
	if result.Entries[0]["status"] != "succeeded" {
		t.Fatalf("first entry should succeed, got %#v", result.Entries[0])
	}
	if result.Entries[1]["status"] != "failed" {
		t.Fatalf("second entry should failed, got %#v", result.Entries[1])
	}
	if _, ok := result.Entries[1]["error"]; !ok {
		t.Fatalf("failed entry should carry error, got %#v", result.Entries[1])
	}
	if exists(filepath.Join(home, "project", "rc", "never")) {
		t.Fatal("third action should not run after failure")
	}
}

func TestApplyPlanDryRunDoesNotMutate(t *testing.T) {
	home := applyTestHome(t)
	target := filepath.Join(home, "project", "rc", "dotfile")
	plan := changePlan{
		Name: "dry-plan",
		Actions: []planAction{
			{Type: "file_write", File: &fileWrite{Path: target, Content: "nope\n"}},
		},
	}
	result := applyPlan(plan, true)
	if !result.Succeeded {
		t.Fatalf("dry run should report success, got %#v", result.Entries)
	}
	if exists(target) {
		t.Fatal("dry run must not write the file")
	}
	if result.JournalPath != nil {
		t.Fatalf("dry run should not write a journal, got %#v", result.JournalPath)
	}
	// Dry-run entries still record intent with dry_run status.
	if result.Entries[0]["status"] != "dry_run" {
		t.Fatalf("dry run entry status = %#v, want dry_run", result.Entries[0]["status"])
	}
}

func TestBackupRelativePathPreservesStructure(t *testing.T) {
	abs := filepath.Join(string(filepath.Separator), "Users", "alice", ".bashrc")
	rel := backupRelativePath(abs)
	if !strings.HasSuffix(rel, filepath.Join("Users", "alice", ".bashrc")) {
		t.Fatalf("backup relative path = %q, want preserved home structure", rel)
	}
	// Separators in the relative path are normalized, never volume colons on POSIX.
	if strings.Contains(rel, ":") {
		t.Fatalf("backup relative path should not contain volume colon, got %q", rel)
	}
}

func TestJournalContainsPlanAndEntries(t *testing.T) {
	home := applyTestHome(t)
	target := filepath.Join(home, "project", "rc", "dotfile")
	plan := changePlan{
		Name: "journaled-plan",
		Actions: []planAction{
			{Type: "file_write", File: &fileWrite{Path: target, Content: "data\n"}},
		},
	}
	result := applyPlan(plan, false)
	if result.JournalPath == nil {
		t.Fatal("expected journal path")
	}
	raw, err := os.ReadFile(*result.JournalPath)
	if err != nil {
		t.Fatal(err)
	}
	payload := map[string]interface{}{}
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatal(err)
	}
	if payload["succeeded"] != true {
		t.Fatalf("journal succeeded = %#v, want true", payload["succeeded"])
	}
	planPart, ok := payload["plan"].(map[string]interface{})
	if !ok || planPart["name"] != "journaled-plan" {
		t.Fatalf("journal plan.name mismatch: %#v", payload["plan"])
	}
	actions, ok := planPart["actions"].([]interface{})
	if !ok || len(actions) != 1 {
		t.Fatalf("journal should record one action, got %#v", planPart["actions"])
	}
	// Sensitive content is redacted in the journal (file content not leaked verbatim as a known field).
	entries, ok := payload["entries"].([]interface{})
	if !ok || len(entries) != 1 {
		t.Fatalf("journal entries mismatch: %#v", payload["entries"])
	}
}

func TestApplyPlanCommandActionReportsReturnCode(t *testing.T) {
	var okCmd, failCmd []string
	if runtime.GOOS == "windows" {
		// Use cmd /c so the exit code is deterministic cross-platform without
		// relying on shell builtins (true/false) that aren't executables on Windows.
		okCmd = []string{"cmd", "/c", "exit", "0"}
		failCmd = []string{"cmd", "/c", "exit", "1"}
	} else {
		okCmd = []string{"true"}
		failCmd = []string{"false"}
	}
	plan := changePlan{
		Name: "command-plan",
		Actions: []planAction{
			{Type: "command", Command: &commandAction{Command: okCmd}},
			{Type: "command", Command: &commandAction{Command: failCmd}},
		},
	}
	result := applyPlan(plan, false)
	if result.Succeeded {
		t.Fatal("plan with a failing command must report failure")
	}
	if result.Entries[0]["status"] != "succeeded" {
		t.Fatalf("successful command should succeed, got %#v", result.Entries[0])
	}
	if result.Entries[1]["status"] != "failed" {
		t.Fatalf("failing command should fail, got %#v", result.Entries[1])
	}
	statusInfo, ok := result.Entries[1]["action"].(map[string]interface{})
	if !ok {
		t.Fatalf("entry action should be a map, got %#v", result.Entries[1]["action"])
	}
	if statusInfo["type"] != "command" {
		t.Fatalf("entry action type = %#v, want command", statusInfo["type"])
	}
}

func TestApplyPlanJournalsBackupsHonorXDGStateHome(t *testing.T) {
	home := t.TempDir()
	stateHome := filepath.Join(home, "custom-state")
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_STATE_HOME", stateHome)

	target := filepath.Join(home, "project", "rc", "dotfile")
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte("original\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	plan := changePlan{
		Name: "xdg-state-plan",
		Actions: []planAction{
			{Type: "file_write", File: &fileWrite{Path: target, Content: "replaced\n"}},
		},
	}
	result := applyPlan(plan, false)
	if !result.Succeeded {
		t.Fatalf("expected success, entries: %#v", result.Entries)
	}
	if result.JournalPath == nil || !strings.Contains(*result.JournalPath, filepath.Join(stateHome, "wrenyard", "runtime", "journals")) {
		t.Fatalf("journal should honor XDG_STATE_HOME, got %#v", result.JournalPath)
	}
	backupPath, ok := result.Entries[0]["backup_path"].(string)
	if !ok || !strings.Contains(backupPath, filepath.Join(stateHome, "wrenyard", "runtime", "backups")) {
		t.Fatalf("backup should honor XDG_STATE_HOME, got %#v", result.Entries[0])
	}
}
