//go:build windows

package driver

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

// acquireAuthGuard attempts a non-blocking exclusive advisory lock on f.
// LockFileEx locks are released by the OS when the owning process exits, so a
// crashed refresh can never leave the lock held.
func acquireAuthGuard(f *os.File) error {
	handle := windows.Handle(f.Fd())
	return windows.LockFileEx(handle,
		windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY,
		0, 1, 0, &windows.Overlapped{})
}

// authGuardContended reports whether an acquireAuthGuard failure means another
// process holds the lock, which is the only case worth retrying.
func authGuardContended(err error) bool {
	return errors.Is(err, windows.ERROR_LOCK_VIOLATION)
}

// releaseAuthGuard unlocks f.
func releaseAuthGuard(f *os.File) error {
	handle := windows.Handle(f.Fd())
	return windows.UnlockFileEx(handle, 0, 1, 0, &windows.Overlapped{})
}
