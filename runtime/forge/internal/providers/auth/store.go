// Package auth owns the Forge auth.json credential store and the
// managed-provider / legacy-secrets credential resolution logic. It does not
// import the root forge package; the root provides the data directory and any
// legacy secret lookups via explicit inputs/callbacks.
package auth

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// Entry represents a single credential entry in auth.json.
type Entry struct {
	Type    string `json:"type"`
	Key     string `json:"key,omitempty"`     // api type
	Refresh string `json:"refresh,omitempty"` // oauth type
	Access  string `json:"access,omitempty"`  // oauth type
	Expires int64  `json:"expires,omitempty"` // oauth type (unix timestamp)
}

// Path returns the auth.json path under the given Forge data directory.
func Path(dataDir string) string {
	return filepath.Join(dataDir, "auth.json")
}

// Read reads the auth.json file at path. Returns an empty map if the file
// doesn't exist.
func Read(path string) (map[string]Entry, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]Entry{}, nil
		}
		return nil, err
	}
	var entries map[string]Entry
	if err := json.Unmarshal(data, &entries); err != nil {
		return nil, fmt.Errorf("invalid auth.json: %w", err)
	}
	return entries, nil
}

// Write atomically writes auth.json at path with 0600 permissions.
func Write(path string, entries map[string]Entry) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		return err
	}
	return SafeAtomicWrite(path, append(data, '\n'), 0o600)
}

// PermsOK checks that the auth.json file at path has 0600 permissions
// (Unix only). On Windows it always returns true.
func PermsOK(path string) bool {
	if runtime.GOOS == "windows" {
		return true
	}
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	return info.Mode().Perm() == 0o600
}

// SafeAtomicWrite is provided by the caller's atomic-write implementation
// (the quota package). The root wires it in.
var SafeAtomicWrite func(target string, data []byte, perm os.FileMode) error
