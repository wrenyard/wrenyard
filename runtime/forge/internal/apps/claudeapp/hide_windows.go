//go:build windows

package claudeapp

import (
	"os/exec"
	"syscall"
)

const windowsCreateNoWindow = 0x08000000

func hideCommandWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: windowsCreateNoWindow,
	}
}
