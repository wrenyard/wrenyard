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

const sourceBlockStart = "# >>> forge shell shortcuts >>>"
const sourceBlockEnd = "# <<< forge shell shortcuts <<<"
const sourceLine = `source "$HOME/.config/forge/shell/forge.zsh"`
const powershellSourceBlockStart = "# >>> forge managed >>>"
const powershellSourceBlockEnd = "# <<< forge managed <<<"
const powershellSourceLine = `. "$HOME\.config\forge\shell\forge.ps1"`
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
