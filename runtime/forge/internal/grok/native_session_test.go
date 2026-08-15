package grok

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

func TestNativeSessionSnapshotRoundTripPersistsOnlyResumeArtifacts(t *testing.T) {
	dataDir := t.TempDir()
	nativeID := "019c-native-session"
	cwd := filepath.Join(t.TempDir(), "workspace")
	runHome, sessionDir := writeNativeSessionFixture(t, nativeID, cwd, "first-state", true)
	for _, file := range []string{"config.toml", "prompt.txt", "auth.json"} {
		if err := os.WriteFile(filepath.Join(runHome, file), []byte("must-not-persist"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(runHome, "hooks"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(runHome, "hooks", "guard.json"), []byte("must-not-persist"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, file := range []string{"plan.json", "signals.json"} {
		if err := os.WriteFile(filepath.Join(sessionDir, file), []byte("unneeded-native-state"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	if err := RefreshNativeSessionSnapshot(dataDir, runHome, nativeID); err != nil {
		t.Fatal(err)
	}
	snapshot, err := NativeSessionSnapshotPath(dataDir, nativeID)
	if err != nil {
		t.Fatal(err)
	}
	wantHash := sha256.Sum256([]byte(nativeID))
	if filepath.Base(snapshot) != hex.EncodeToString(wantHash[:]) || strings.Contains(snapshot, nativeID) {
		t.Fatalf("snapshot path is not keyed only by the path-safe native-id hash: %s", snapshot)
	}
	location, err := validateSnapshotTree(snapshot, nativeID)
	if err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(location.sessionDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 3 || entries[0].Name() != "chat_history.jsonl" || entries[1].Name() != "summary.json" || entries[2].Name() != "updates.jsonl" {
		t.Fatalf("snapshot persisted more than the minimum native resume artifacts: %v", entries)
	}
	for _, forbidden := range []string{"config.toml", "prompt.txt", "auth.json", "hooks", "plan.json", "signals.json"} {
		if strings.Contains(snapshotTreeNames(t, snapshot), forbidden) {
			t.Fatalf("snapshot persisted forbidden or unrelated run artifact %q", forbidden)
		}
	}

	restoredHome := t.TempDir()
	if err := os.WriteFile(filepath.Join(restoredHome, "config.toml"), []byte("new-run-config"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := RestoreNativeSessionSnapshot(dataDir, restoredHome, nativeID); err != nil {
		t.Fatal(err)
	}
	restored, err := findRunHomeSession(restoredHome, nativeID)
	if err != nil {
		t.Fatal(err)
	}
	if state := readNativeSessionState(t, restored.sessionDir); state != "first-state" {
		t.Fatalf("restored native state = %q, want first-state", state)
	}
	if config, err := os.ReadFile(filepath.Join(restoredHome, "config.toml")); err != nil || string(config) != "new-run-config" {
		t.Fatalf("restore changed the fresh run config: %q err=%v", config, err)
	}
	assertPrivateTree(t, snapshot)
}

func TestNativeSessionRestoreMissingCorruptAndTraversalFailClosed(t *testing.T) {
	t.Run("missing", func(t *testing.T) {
		dataDir := t.TempDir()
		runHome := t.TempDir()
		err := RestoreNativeSessionSnapshot(dataDir, runHome, "missing-native-session")
		if err == nil || !strings.Contains(err.Error(), "was not found") {
			t.Fatalf("missing snapshot error = %v", err)
		}
		if _, statErr := os.Stat(filepath.Join(runHome, "sessions")); !os.IsNotExist(statErr) {
			t.Fatalf("missing restore created sessions: %v", statErr)
		}
	})

	for _, corruption := range []string{"summary", "updates", "chat_history", "extra"} {
		t.Run("corrupt_"+corruption, func(t *testing.T) {
			dataDir := t.TempDir()
			nativeID := "corrupt-native-session"
			source, _ := writeNativeSessionFixture(t, nativeID, t.TempDir(), "valid", false)
			if err := RefreshNativeSessionSnapshot(dataDir, source, nativeID); err != nil {
				t.Fatal(err)
			}
			snapshot, _ := NativeSessionSnapshotPath(dataDir, nativeID)
			location, err := validateSnapshotTree(snapshot, nativeID)
			if err != nil {
				t.Fatal(err)
			}
			switch corruption {
			case "summary":
				if err := os.WriteFile(filepath.Join(location.sessionDir, "summary.json"), []byte(`{"info":`), 0o600); err != nil {
					t.Fatal(err)
				}
			case "updates":
				if err := os.WriteFile(filepath.Join(location.sessionDir, "updates.jsonl"), []byte(`{"type":`), 0o600); err != nil {
					t.Fatal(err)
				}
			case "chat_history":
				if err := os.WriteFile(filepath.Join(location.sessionDir, "chat_history.jsonl"), []byte(`{"role":`), 0o600); err != nil {
					t.Fatal(err)
				}
			case "extra":
				if err := os.WriteFile(filepath.Join(snapshot, "auth.json"), []byte("unrelated"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			unrelated := filepath.Join(NativeSessionStoreRoot(dataDir), "unrelated-state")
			if err := os.MkdirAll(unrelated, 0o700); err != nil {
				t.Fatal(err)
			}
			marker := filepath.Join(unrelated, "keep")
			if err := os.WriteFile(marker, []byte("unchanged"), 0o600); err != nil {
				t.Fatal(err)
			}
			restoredHome := t.TempDir()
			err = RestoreNativeSessionSnapshot(dataDir, restoredHome, nativeID)
			if err == nil || !strings.Contains(err.Error(), "is invalid") {
				t.Fatalf("corrupt snapshot restore error = %v", err)
			}
			if got, readErr := os.ReadFile(marker); readErr != nil || string(got) != "unchanged" {
				t.Fatalf("corrupt restore deleted unrelated state: %q err=%v", got, readErr)
			}
			if _, statErr := os.Stat(filepath.Join(restoredHome, "sessions")); !os.IsNotExist(statErr) {
				t.Fatalf("corrupt restore installed partial sessions: %v", statErr)
			}
		})
	}

	t.Run("path traversal id", func(t *testing.T) {
		dataDir := t.TempDir()
		runHome := t.TempDir()
		nativeID := filepath.Join("..", "..", "escape")
		path, err := NativeSessionSnapshotPath(dataDir, nativeID)
		if err != nil {
			t.Fatal(err)
		}
		root, _ := filepath.Abs(NativeSessionStoreRoot(dataDir))
		if filepath.Dir(path) != root || len(filepath.Base(path)) != 64 || strings.Contains(path, "escape") {
			t.Fatalf("traversal id escaped hashed store path: %s", path)
		}
		outside := filepath.Join(filepath.Dir(runHome), "escape")
		if err := os.WriteFile(outside, []byte("sentinel"), 0o600); err != nil {
			t.Fatal(err)
		}
		err = RestoreNativeSessionSnapshot(dataDir, runHome, nativeID)
		if err == nil || !strings.Contains(err.Error(), "was not found") {
			t.Fatalf("traversal resume error = %v", err)
		}
		if got, readErr := os.ReadFile(outside); readErr != nil || string(got) != "sentinel" {
			t.Fatalf("traversal resume touched outside sentinel: %q err=%v", got, readErr)
		}
	})
}

func TestNativeSessionConcurrentRefreshIsAtomic(t *testing.T) {
	dataDir := t.TempDir()
	nativeID := "concurrent-native-session"
	sourceA, _ := writeNativeSessionFixture(t, nativeID, t.TempDir(), strings.Repeat("A", 4096), false)
	sourceB, _ := writeNativeSessionFixture(t, nativeID, t.TempDir(), strings.Repeat("B", 4096), false)
	start := make(chan struct{})
	errs := make(chan error, 16)
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		source := sourceA
		if i%2 == 1 {
			source = sourceB
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			errs <- RefreshNativeSessionSnapshot(dataDir, source, nativeID)
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent refresh failed: %v", err)
		}
	}
	restoredHome := t.TempDir()
	if err := RestoreNativeSessionSnapshot(dataDir, restoredHome, nativeID); err != nil {
		t.Fatal(err)
	}
	restored, err := findRunHomeSession(restoredHome, nativeID)
	if err != nil {
		t.Fatal(err)
	}
	state := readNativeSessionState(t, restored.sessionDir)
	if state != strings.Repeat("A", 4096) && state != strings.Repeat("B", 4096) {
		t.Fatalf("atomic refresh restored mixed or partial state of length %d", len(state))
	}
	entries, err := os.ReadDir(NativeSessionStoreRoot(dataDir))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.Contains(entry.Name(), ".tmp-") || strings.Contains(entry.Name(), ".old-") {
			t.Fatalf("atomic refresh left replacement artifact %q", entry.Name())
		}
	}
}

func TestNativeSessionRefreshRejectsIncompleteArtifacts(t *testing.T) {
	dataDir := t.TempDir()
	nativeID := "incomplete-native-session"
	runHome, sessionDir := writeNativeSessionFixture(t, nativeID, t.TempDir(), "state", false)
	if err := os.Remove(filepath.Join(sessionDir, "updates.jsonl")); err != nil {
		t.Fatal(err)
	}
	err := RefreshNativeSessionSnapshot(dataDir, runHome, nativeID)
	if err == nil || !strings.Contains(err.Error(), "updates.jsonl") {
		t.Fatalf("incomplete refresh error = %v", err)
	}
	path, _ := NativeSessionSnapshotPath(dataDir, nativeID)
	if _, statErr := os.Stat(path); !os.IsNotExist(statErr) {
		t.Fatalf("incomplete refresh installed a snapshot: %v", statErr)
	}
}

func writeNativeSessionFixture(t *testing.T, nativeID, cwd, state string, withCWDMarker bool) (string, string) {
	t.Helper()
	runHome := t.TempDir()
	groupDir := filepath.Join(runHome, "sessions", "encoded-workspace")
	sessionDir := filepath.Join(groupDir, nativeID)
	if err := os.MkdirAll(sessionDir, 0o700); err != nil {
		t.Fatal(err)
	}
	summary, err := json.Marshal(map[string]any{
		"info": map[string]string{"id": nativeID, "cwd": cwd}, "num_messages": 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sessionDir, "summary.json"), summary, 0o600); err != nil {
		t.Fatal(err)
	}
	update, err := json.Marshal(map[string]string{"type": "native_test_state", "state": state})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sessionDir, "updates.jsonl"), append(update, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	chat, err := json.Marshal(map[string]string{"role": "user", "content": state})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sessionDir, "chat_history.jsonl"), append(chat, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	if withCWDMarker {
		if err := os.WriteFile(filepath.Join(groupDir, ".cwd"), []byte(cwd+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return runHome, sessionDir
}

func readNativeSessionState(t *testing.T, sessionDir string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(sessionDir, "updates.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	var update map[string]string
	if err := json.Unmarshal(data, &update); err != nil {
		t.Fatal(err)
	}
	return update["state"]
}

func snapshotTreeNames(t *testing.T, root string) string {
	t.Helper()
	var names []string
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		names = append(names, rel)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return strings.Join(names, "\n")
}

func assertPrivateTree(t *testing.T, root string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		return
	}
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode().Perm()&0o077 != 0 {
			t.Errorf("native session snapshot path %s has permissive mode %o", path, info.Mode().Perm())
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
