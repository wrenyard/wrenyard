//go:build windows

package quota

import (
	"os"

	"golang.org/x/sys/windows"
)

// acquireGuardNB attempts a non-blocking exclusive lock on f.
// Returns nil on success, error if the lock is held by another process.
func acquireGuardNB(f *os.File) error {
	handle := windows.Handle(f.Fd())
	return windows.LockFileEx(handle,
		windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY,
		0, 1, 0, &windows.Overlapped{})
}

// acquireGuard acquires a blocking exclusive lock on f.
func acquireGuard(f *os.File) error {
	handle := windows.Handle(f.Fd())
	return windows.LockFileEx(handle,
		windows.LOCKFILE_EXCLUSIVE_LOCK,
		0, 1, 0, &windows.Overlapped{})
}

// releaseGuard unlocks f.
func releaseGuard(f *os.File) error {
	handle := windows.Handle(f.Fd())
	return windows.UnlockFileEx(handle, 0, 1, 0, &windows.Overlapped{})
}
