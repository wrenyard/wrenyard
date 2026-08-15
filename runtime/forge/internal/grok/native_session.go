package grok

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const nativeSessionStoreDirectory = "agent-grok-native-sessions"

var nativeSessionArtifactNames = []string{"summary.json", "updates.jsonl", "chat_history.jsonl"}

type nativeSessionLocation struct {
	groupName   string
	sessionName string
	groupDir    string
	sessionDir  string
	cwdFile     string
}

// NativeSessionStoreRoot is the Forge-owned subtree containing only minimal
// downstream-native Grok resume snapshots. Snapshot identities are hashes of
// Grok's own session IDs; Forge never creates a durable session identity.
func NativeSessionStoreRoot(forgeDataDir string) string {
	return filepath.Join(forgeDataDir, "grok", nativeSessionStoreDirectory)
}

// NativeSessionSnapshotPath returns the path-safe storage path for a native
// Grok session ID. It is exported so lifecycle diagnostics and tests can
// inspect the exact production location without reproducing the key scheme.
func NativeSessionSnapshotPath(forgeDataDir, nativeSessionID string) (string, error) {
	id, err := normalizeNativeSessionID(nativeSessionID)
	if err != nil {
		return "", err
	}
	root, err := nativeSessionStoreRoot(forgeDataDir)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(id))
	return filepath.Join(root, hex.EncodeToString(sum[:])), nil
}

// RefreshNativeSessionSnapshot atomically replaces the durable snapshot for a
// native Grok session with the minimum documented 0.2.106 resume state from a
// completed child attempt: summary.json, updates.jsonl, chat_history.jsonl, and
// the optional .cwd marker used by long encoded-workspace paths. Installed
// 0.2.106 resume uses chat_history.jsonl to rebuild the next model request even
// though updates.jsonl remains the authoritative session event stream.
func RefreshNativeSessionSnapshot(forgeDataDir, runHome, nativeSessionID string) error {
	id, err := normalizeNativeSessionID(nativeSessionID)
	if err != nil {
		return err
	}
	target, err := NativeSessionSnapshotPath(forgeDataDir, id)
	if err != nil {
		return err
	}
	root := filepath.Dir(target)
	if err := ensurePrivateDirectory(root); err != nil {
		return fmt.Errorf("create native Grok session store: %w", err)
	}
	key := filepath.Base(target)
	lock, err := acquireNativeSessionLock(filepath.Join(root, ".locks", key+".lock"))
	if err != nil {
		return fmt.Errorf("lock native Grok session snapshot %q: %w", id, err)
	}
	defer lock.Release()

	location, err := findRunHomeSession(runHome, id)
	if err != nil {
		return fmt.Errorf("snapshot native Grok session %q: %w", id, err)
	}
	if err := validateNativeSessionArtifacts(location, id); err != nil {
		return fmt.Errorf("snapshot native Grok session %q: %w", id, err)
	}

	stage, err := os.MkdirTemp(root, "."+key+".tmp-")
	if err != nil {
		return fmt.Errorf("stage native Grok session snapshot: %w", err)
	}
	stageOwned := true
	defer func() {
		if stageOwned {
			_ = os.RemoveAll(stage)
		}
	}()
	if err := os.Chmod(stage, 0o700); err != nil {
		return fmt.Errorf("restrict native Grok session snapshot staging: %w", err)
	}

	stagedLocation, err := copyNativeSessionArtifacts(stage, location)
	if err != nil {
		return err
	}
	if _, err := validateSnapshotTree(stage, id); err != nil {
		return fmt.Errorf("validate staged native Grok session snapshot: %w", err)
	}
	if stagedLocation.sessionName != id {
		return fmt.Errorf("validate staged native Grok session snapshot: session id mismatch")
	}
	if err := replaceSnapshotDirectory(root, target, stage, key); err != nil {
		return err
	}
	stageOwned = false
	return nil
}

// RestoreNativeSessionSnapshot restores a validated snapshot into one fresh,
// unique run Home before Grok is launched. Missing or malformed state fails
// closed and never removes or rewrites the stored snapshot.
func RestoreNativeSessionSnapshot(forgeDataDir, runHome, nativeSessionID string) error {
	id, err := normalizeNativeSessionID(nativeSessionID)
	if err != nil {
		return err
	}
	target, err := NativeSessionSnapshotPath(forgeDataDir, id)
	if err != nil {
		return err
	}
	root := filepath.Dir(target)
	key := filepath.Base(target)
	lock, err := acquireNativeSessionLock(filepath.Join(root, ".locks", key+".lock"))
	if err != nil {
		return fmt.Errorf("lock native Grok resume snapshot %q: %w", id, err)
	}
	defer lock.Release()

	info, err := os.Lstat(target)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("native Grok resume snapshot for session %q was not found", id)
		}
		return fmt.Errorf("read native Grok resume snapshot for session %q: %w", id, err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("native Grok resume snapshot for session %q is invalid: snapshot root is not a directory", id)
	}
	location, err := validateSnapshotTree(target, id)
	if err != nil {
		return fmt.Errorf("native Grok resume snapshot for session %q is invalid: %w", id, err)
	}

	runHome, err = existingPrivateDirectory(runHome)
	if err != nil {
		return fmt.Errorf("restore native Grok resume snapshot: %w", err)
	}
	sessionsTarget := filepath.Join(runHome, "sessions")
	if _, err := os.Lstat(sessionsTarget); err == nil {
		return fmt.Errorf("restore native Grok resume snapshot: fresh run Home already contains sessions")
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("restore native Grok resume snapshot: inspect fresh run Home: %w", err)
	}

	stage, err := os.MkdirTemp(runHome, ".native-session-restore-")
	if err != nil {
		return fmt.Errorf("stage native Grok resume snapshot: %w", err)
	}
	defer os.RemoveAll(stage)
	if err := os.Chmod(stage, 0o700); err != nil {
		return fmt.Errorf("restrict native Grok resume staging: %w", err)
	}
	if _, err := copyNativeSessionArtifacts(stage, location); err != nil {
		return fmt.Errorf("restore native Grok resume snapshot: %w", err)
	}
	if _, err := validateSnapshotTree(stage, id); err != nil {
		return fmt.Errorf("validate restored native Grok resume snapshot: %w", err)
	}
	if err := os.Rename(filepath.Join(stage, "sessions"), sessionsTarget); err != nil {
		return fmt.Errorf("install native Grok resume snapshot: %w", err)
	}
	return nil
}

func normalizeNativeSessionID(nativeSessionID string) (string, error) {
	id := strings.TrimSpace(nativeSessionID)
	if id == "" || strings.ContainsAny(id, "\x00\r\n") {
		return "", fmt.Errorf("native Grok session id is invalid")
	}
	return id, nil
}

func nativeSessionStoreRoot(forgeDataDir string) (string, error) {
	if strings.TrimSpace(forgeDataDir) == "" {
		return "", fmt.Errorf("Forge data directory is empty")
	}
	root, err := filepath.Abs(NativeSessionStoreRoot(forgeDataDir))
	if err != nil {
		return "", fmt.Errorf("resolve native Grok session store: %w", err)
	}
	return root, nil
}

func existingPrivateDirectory(path string) (string, error) {
	if strings.TrimSpace(path) == "" {
		return "", fmt.Errorf("run Home is empty")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("resolve run Home: %w", err)
	}
	info, err := os.Lstat(abs)
	if err != nil {
		return "", err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("run Home is not a directory")
	}
	return abs, nil
}

func ensurePrivateDirectory(path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("path is not a directory")
	}
	return os.Chmod(path, 0o700)
}

func findRunHomeSession(runHome, nativeSessionID string) (nativeSessionLocation, error) {
	home, err := existingPrivateDirectory(runHome)
	if err != nil {
		return nativeSessionLocation{}, err
	}
	sessionsRoot := filepath.Join(home, "sessions")
	groups, err := os.ReadDir(sessionsRoot)
	if err != nil {
		if os.IsNotExist(err) {
			return nativeSessionLocation{}, fmt.Errorf("Grok sessions subtree is missing")
		}
		return nativeSessionLocation{}, fmt.Errorf("read Grok sessions subtree: %w", err)
	}
	var found []nativeSessionLocation
	for _, group := range groups {
		groupInfo, err := group.Info()
		if err != nil || !groupInfo.IsDir() || groupInfo.Mode()&os.ModeSymlink != 0 {
			continue
		}
		groupDir := filepath.Join(sessionsRoot, group.Name())
		entries, err := os.ReadDir(groupDir)
		if err != nil {
			return nativeSessionLocation{}, fmt.Errorf("read Grok encoded-workspace directory: %w", err)
		}
		for _, entry := range entries {
			if entry.Name() != nativeSessionID {
				continue
			}
			entryInfo, err := entry.Info()
			if err != nil || !entryInfo.IsDir() || entryInfo.Mode()&os.ModeSymlink != 0 {
				return nativeSessionLocation{}, fmt.Errorf("native session entry is not a directory")
			}
			location := nativeSessionLocation{
				groupName:   group.Name(),
				sessionName: entry.Name(),
				groupDir:    groupDir,
				sessionDir:  filepath.Join(groupDir, entry.Name()),
			}
			cwdFile := filepath.Join(groupDir, ".cwd")
			if _, err := os.Lstat(cwdFile); err == nil {
				location.cwdFile = cwdFile
			} else if !os.IsNotExist(err) {
				return nativeSessionLocation{}, fmt.Errorf("inspect Grok encoded-workspace marker: %w", err)
			}
			found = append(found, location)
		}
	}
	if len(found) == 0 {
		return nativeSessionLocation{}, fmt.Errorf("native session artifacts were not found")
	}
	if len(found) != 1 {
		return nativeSessionLocation{}, fmt.Errorf("native session artifacts are ambiguous across encoded workspaces")
	}
	return found[0], nil
}

func validateNativeSessionArtifacts(location nativeSessionLocation, nativeSessionID string) error {
	if location.sessionName != nativeSessionID || location.groupName == "" {
		return fmt.Errorf("native session path does not match the requested id")
	}
	if location.cwdFile != "" {
		if err := validateRegularFile(location.cwdFile); err != nil {
			return fmt.Errorf("invalid encoded-workspace marker: %w", err)
		}
	}
	summaryPath := filepath.Join(location.sessionDir, "summary.json")
	if err := validateRegularFile(summaryPath); err != nil {
		return fmt.Errorf("invalid summary.json: %w", err)
	}
	data, err := os.ReadFile(summaryPath)
	if err != nil {
		return fmt.Errorf("read summary.json: %w", err)
	}
	var summary struct {
		Info struct {
			ID  string `json:"id"`
			CWD string `json:"cwd"`
		} `json:"info"`
	}
	if err := json.Unmarshal(data, &summary); err != nil {
		return fmt.Errorf("parse summary.json: %w", err)
	}
	if summary.Info.ID != nativeSessionID || strings.TrimSpace(summary.Info.CWD) == "" {
		return fmt.Errorf("summary.json does not identify the requested native session")
	}
	updatesPath := filepath.Join(location.sessionDir, "updates.jsonl")
	if err := validateRegularFile(updatesPath); err != nil {
		return fmt.Errorf("invalid updates.jsonl: %w", err)
	}
	if err := validateJSONObjects(updatesPath); err != nil {
		return fmt.Errorf("parse updates.jsonl: %w", err)
	}
	chatHistoryPath := filepath.Join(location.sessionDir, "chat_history.jsonl")
	if err := validateRegularFile(chatHistoryPath); err != nil {
		return fmt.Errorf("invalid chat_history.jsonl: %w", err)
	}
	if err := validateJSONObjects(chatHistoryPath); err != nil {
		return fmt.Errorf("parse chat_history.jsonl: %w", err)
	}
	return nil
}

func validateRegularFile(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("not a regular file")
	}
	return nil
}

func validateJSONObjects(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	decoder := json.NewDecoder(file)
	count := 0
	for {
		var value map[string]any
		err := decoder.Decode(&value)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}
		if value == nil {
			return fmt.Errorf("record %d is not a JSON object", count+1)
		}
		count++
	}
	if count == 0 {
		return fmt.Errorf("file contains no session updates")
	}
	return nil
}

func copyNativeSessionArtifacts(destinationRoot string, source nativeSessionLocation) (nativeSessionLocation, error) {
	groupDir := filepath.Join(destinationRoot, "sessions", source.groupName)
	sessionDir := filepath.Join(groupDir, source.sessionName)
	if err := os.MkdirAll(sessionDir, 0o700); err != nil {
		return nativeSessionLocation{}, fmt.Errorf("create native Grok session snapshot directories: %w", err)
	}
	if err := os.Chmod(filepath.Join(destinationRoot, "sessions"), 0o700); err != nil {
		return nativeSessionLocation{}, fmt.Errorf("restrict native Grok sessions snapshot: %w", err)
	}
	if err := os.Chmod(groupDir, 0o700); err != nil {
		return nativeSessionLocation{}, fmt.Errorf("restrict native Grok workspace snapshot: %w", err)
	}
	if err := os.Chmod(sessionDir, 0o700); err != nil {
		return nativeSessionLocation{}, fmt.Errorf("restrict native Grok session snapshot: %w", err)
	}
	for _, name := range nativeSessionArtifactNames {
		if err := copyPrivateFile(filepath.Join(source.sessionDir, name), filepath.Join(sessionDir, name)); err != nil {
			return nativeSessionLocation{}, fmt.Errorf("copy native Grok %s: %w", name, err)
		}
	}
	cwdFile := ""
	if source.cwdFile != "" {
		cwdFile = filepath.Join(groupDir, ".cwd")
		if err := copyPrivateFile(source.cwdFile, cwdFile); err != nil {
			return nativeSessionLocation{}, fmt.Errorf("copy native Grok encoded-workspace marker: %w", err)
		}
	}
	return nativeSessionLocation{
		groupName: source.groupName, sessionName: source.sessionName,
		groupDir: groupDir, sessionDir: sessionDir, cwdFile: cwdFile,
	}, nil
}

func copyPrivateFile(source, target string) error {
	if err := validateRegularFile(source); err != nil {
		return err
	}
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	ok := false
	defer func() {
		_ = out.Close()
		if !ok {
			_ = os.Remove(target)
		}
	}()
	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	if err := out.Sync(); err != nil {
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	ok = true
	return nil
}

func validateSnapshotTree(root, nativeSessionID string) (nativeSessionLocation, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nativeSessionLocation{}, err
	}
	if len(entries) != 1 || entries[0].Name() != "sessions" || !entries[0].IsDir() {
		return nativeSessionLocation{}, fmt.Errorf("snapshot contains files outside the native sessions subtree")
	}
	sessionsRoot := filepath.Join(root, "sessions")
	groups, err := os.ReadDir(sessionsRoot)
	if err != nil || len(groups) != 1 || !groups[0].IsDir() {
		return nativeSessionLocation{}, fmt.Errorf("snapshot must contain exactly one encoded-workspace directory")
	}
	groupName := groups[0].Name()
	groupDir := filepath.Join(sessionsRoot, groupName)
	groupEntries, err := os.ReadDir(groupDir)
	if err != nil {
		return nativeSessionLocation{}, err
	}
	location := nativeSessionLocation{groupName: groupName, groupDir: groupDir}
	for _, entry := range groupEntries {
		switch entry.Name() {
		case ".cwd":
			if location.cwdFile != "" || entry.IsDir() {
				return nativeSessionLocation{}, fmt.Errorf("invalid encoded-workspace marker")
			}
			location.cwdFile = filepath.Join(groupDir, entry.Name())
		default:
			if location.sessionDir != "" || !entry.IsDir() || entry.Name() != nativeSessionID {
				return nativeSessionLocation{}, fmt.Errorf("snapshot session directory does not match the requested native id")
			}
			location.sessionName = entry.Name()
			location.sessionDir = filepath.Join(groupDir, entry.Name())
		}
	}
	if location.sessionDir == "" {
		return nativeSessionLocation{}, fmt.Errorf("snapshot has no native session directory")
	}
	sessionEntries, err := os.ReadDir(location.sessionDir)
	if err != nil {
		return nativeSessionLocation{}, err
	}
	if len(sessionEntries) != len(nativeSessionArtifactNames) {
		return nativeSessionLocation{}, fmt.Errorf("snapshot does not contain the minimal native session artifact set")
	}
	for _, name := range nativeSessionArtifactNames {
		found := false
		for _, entry := range sessionEntries {
			if entry.Name() == name && !entry.IsDir() {
				found = true
				break
			}
		}
		if !found {
			return nativeSessionLocation{}, fmt.Errorf("snapshot is missing %s", name)
		}
	}
	if err := validateNativeSessionArtifacts(location, nativeSessionID); err != nil {
		return nativeSessionLocation{}, err
	}
	return location, nil
}

func replaceSnapshotDirectory(root, target, stage, key string) error {
	backup := filepath.Join(root, "."+key+".old-"+fmt.Sprintf("%d", time.Now().UnixNano()))
	oldExists := false
	if info, err := os.Lstat(target); err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("replace native Grok session snapshot: existing target is not a directory")
		}
		if err := os.Rename(target, backup); err != nil {
			return fmt.Errorf("replace native Grok session snapshot: preserve previous snapshot: %w", err)
		}
		oldExists = true
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("replace native Grok session snapshot: inspect previous snapshot: %w", err)
	}
	if err := os.Rename(stage, target); err != nil {
		if oldExists {
			_ = os.Rename(backup, target)
		}
		return fmt.Errorf("replace native Grok session snapshot: install staged snapshot: %w", err)
	}
	if oldExists {
		if err := os.RemoveAll(backup); err != nil {
			return fmt.Errorf("replace native Grok session snapshot: remove replaced snapshot: %w", err)
		}
	}
	return nil
}
