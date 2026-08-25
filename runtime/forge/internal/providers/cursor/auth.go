package cursor

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	_ "modernc.org/sqlite"
)

// accessTokenKey is the key under which Cursor Desktop persists its access
// token inside the state.vscdb ItemTable.
const accessTokenKey = "cursorAuth/accessToken"

// StatePath resolves the Cursor Desktop state.vscdb path for the current
// platform. When home is empty it is resolved from HOME/USERPROFILE. Passing a
// home allows tests to point at a temporary directory.
func StatePath(home string) string {
	if home == "" {
		home = os.Getenv("HOME")
	}
	if home == "" {
		home = os.Getenv("USERPROFILE")
	}
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb")
	case "windows":
		appData := os.Getenv("APPDATA")
		if appData == "" {
			appData = filepath.Join(home, "AppData", "Roaming")
		}
		return filepath.Join(appData, "Cursor", "User", "globalStorage", "state.vscdb")
	default:
		config := os.Getenv("XDG_CONFIG_HOME")
		if config == "" {
			config = filepath.Join(home, ".config")
		}
		return filepath.Join(config, "Cursor", "User", "globalStorage", "state.vscdb")
	}
}

// AccessToken opens the Cursor Desktop state.vscdb read-only and returns the
// stored access token. The token is never cached, logged, or persisted; every
// returned error is sanitized so it can never leak the token.
func AccessToken(statePath string) (string, error) {
	if strings.TrimSpace(statePath) == "" {
		return "", fmt.Errorf("cursor: empty state database path")
	}
	db, err := sql.Open("sqlite", "file:"+statePath+"?mode=ro")
	if err != nil {
		return "", fmt.Errorf("cursor: open state database: %w", err)
	}
	defer db.Close()

	var token string
	if err := db.QueryRow(
		"SELECT value FROM ItemTable WHERE key = ?",
		accessTokenKey,
	).Scan(&token); err != nil {
		return "", fmt.Errorf("cursor: read access token: %w", err)
	}
	return token, nil
}
