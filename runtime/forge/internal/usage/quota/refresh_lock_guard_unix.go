//go:build !windows

package quota

import (
	"os"

	"golang.org/x/sys/unix"
)

// acquireGuardNB attempts a non-blocking exclusive lock on f.
// Returns nil on success, error if the lock is held by another process.
func acquireGuardNB(f *os.File) error {
	return unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB)
}

// acquireGuard acquires a blocking exclusive lock on f.
func acquireGuard(f *os.File) error {
	return unix.Flock(int(f.Fd()), unix.LOCK_EX)
}

// releaseGuard unlocks f.
func releaseGuard(f *os.File) error {
	return unix.Flock(int(f.Fd()), unix.LOCK_UN)
}
