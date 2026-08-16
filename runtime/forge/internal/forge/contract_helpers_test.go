package forge

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/auth"
	sl "github.com/wrenyard/wrenyard/runtime/forge/internal/usage/statusline"
)

const sourceBlockStart = "# >>> wrenyard shell shortcuts >>>"
const sourceBlockEnd = "# <<< wrenyard shell shortcuts <<<"
const sourceLine = `source "$HOME/.config/wrenyard/runtime/shell/wrenyard.zsh"`
const powershellSourceBlockStart = "# >>> wrenyard managed >>>"
const powershellSourceBlockEnd = "# <<< wrenyard managed <<<"
const powershellSourceLine = `. "$HOME\.config\wrenyard\runtime\shell\wrenyard.ps1"`

// Legacy prerelease Forge markers, used by fixtures that simulate profiles
// created before the Wrenyard rename.
const legacySourceBlockStart = "# >>> forge shell shortcuts >>>"
const legacySourceBlockEnd = "# <<< forge shell shortcuts <<<"
const legacyPowershellSourceBlockStart = "# >>> forge managed >>>"
const legacyPowershellSourceBlockEnd = "# <<< forge managed <<<"
const redactionPlaceholder = auth.RedactionPlaceholder
const openCodeProviderNotFound = sl.OpenCodeProviderNotFound

type ioDiscard struct{}

func (ioDiscard) Write(p []byte) (int, error) { return len(p), nil }

func contains(items []string, want string) bool {
	for _, item := range items {
		if item == want {
			return true
		}
	}
	return false
}

func ptrString(value *string) string {
	if value == nil {
		return "<nil>"
	}
	return *value
}

func exitCode(err error) int {
	if err == nil {
		return 0
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode()
	}
	return 1
}

func writeJSON(path string, value interface{}) error {
	content, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, append(content, '\n'), 0o644)
}

func readJSONMap(path string) map[string]interface{} {
	return readSecretsFile(path)
}
