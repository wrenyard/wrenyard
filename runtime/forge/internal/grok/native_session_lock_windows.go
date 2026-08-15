//go:build windows

package grok

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

func acquireNativeSessionGuardNB(file *os.File) error {
	return windows.LockFileEx(windows.Handle(file.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &windows.Overlapped{})
}

func releaseNativeSessionGuard(file *os.File) error {
	return windows.UnlockFileEx(windows.Handle(file.Fd()), 0, 1, 0, &windows.Overlapped{})
}

func nativeSessionOwnerLiveness(pid int) nativeSessionOwnerState {
	if pid <= 0 {
		return nativeSessionOwnerUnknown
	}
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
			return nativeSessionOwnerDead
		}
		return nativeSessionOwnerUnknown
	}
	defer windows.CloseHandle(handle)
	result, err := windows.WaitForSingleObject(handle, 0)
	if err != nil {
		return nativeSessionOwnerUnknown
	}
	switch result {
	case uint32(windows.WAIT_TIMEOUT):
		return nativeSessionOwnerAlive
	case windows.WAIT_OBJECT_0:
		return nativeSessionOwnerDead
	default:
		return nativeSessionOwnerUnknown
	}
}
