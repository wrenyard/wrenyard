//go:build windows

package quota

import (
	"os/exec"
	"testing"
)

// TestApplyDetachedNoWindowInvariants pins the Windows no-window worker
// contract: detached Forge quota workers must combine DETACHED_PROCESS,
// CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW and HideWindow so neither the
// worker nor the Chrome it spawns produces a console/window surface.
func TestApplyDetachedNoWindowInvariants(t *testing.T) {
	cmd := exec.Command("cmd.exe", "/c", "echo test")
	applyDetached(cmd)

	if cmd.SysProcAttr == nil {
		t.Fatal("SysProcAttr should not be nil after applyDetached")
	}
	if cmd.SysProcAttr.CreationFlags&_DETACHED_PROCESS == 0 {
		t.Fatal("CreationFlags should contain DETACHED_PROCESS (0x00000008)")
	}
	if cmd.SysProcAttr.CreationFlags&_CREATE_NEW_PROCESS_GROUP == 0 {
		t.Fatal("CreationFlags should contain CREATE_NEW_PROCESS_GROUP (0x00000200)")
	}
	if cmd.SysProcAttr.CreationFlags&_CREATE_NO_WINDOW == 0 {
		t.Fatal("CreationFlags should contain CREATE_NO_WINDOW (0x08000000)")
	}
	if !cmd.SysProcAttr.HideWindow {
		t.Fatal("HideWindow should be true after applyDetached")
	}
}
