//go:build windows

package quota

import (
	"os/exec"
	"syscall"
)

const (
	_DETACHED_PROCESS         = 0x00000008
	_CREATE_NEW_PROCESS_GROUP = 0x00000200
	_CREATE_NO_WINDOW         = 0x08000000
)

func applyDetached(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	// DETACHED_PROCESS: the child has no console.
	// CREATE_NEW_PROCESS_GROUP: the child is in its own group and won't
	// receive CTRL_C / CTRL_BREAK from the parent's console.
	// CREATE_NO_WINDOW + HideWindow: neither the worker nor any browser it
	// launches produces a visible console or window surface on Windows.
	cmd.SysProcAttr.HideWindow = true
	cmd.SysProcAttr.CreationFlags = _DETACHED_PROCESS | _CREATE_NEW_PROCESS_GROUP | _CREATE_NO_WINDOW
}
