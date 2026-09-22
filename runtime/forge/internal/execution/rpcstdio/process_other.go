//go:build !windows

package rpcstdio

import "os/exec"

// applyHiddenProcess is a no-op on non-Windows platforms.
func applyHiddenProcess(cmd *exec.Cmd) {
	// Windows hidden process flag is not applicable on this platform.
}
