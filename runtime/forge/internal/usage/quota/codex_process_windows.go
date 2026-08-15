//go:build windows

package quota

import (
	"os/exec"
	"syscall"
)

// applyCodexHiddenProcess configures the exec.Cmd to create the codex
// app-server subprocess with a hidden window and no visible console on
// Windows, preventing console flashing during JSON-RPC stdio communication.
func applyCodexHiddenProcess(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
	cmd.SysProcAttr.CreationFlags |= 0x08000000 // CREATE_NO_WINDOW
}
