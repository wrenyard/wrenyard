//go:build !windows

package quota

import "os/exec"

// applyCodexHiddenProcess is a no-op on non-Windows platforms.
func applyCodexHiddenProcess(cmd *exec.Cmd) {
	// Windows hidden process flag is not applicable on this platform.
}
