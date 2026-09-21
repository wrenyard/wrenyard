//go:build windows

package rpcstdio

import (
	"os/exec"
	"syscall"
)

// applyHiddenProcess configures the exec.Cmd to create client subprocesses with a hidden window and no visible console on
// Windows, preventing console flashing during JSON-RPC stdio communication.
func applyHiddenProcess(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
	cmd.SysProcAttr.CreationFlags |= 0x08000000 // CREATE_NO_WINDOW
}
