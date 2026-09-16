//go:build !windows

package driver

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

// acquireAuthGuard attempts a non-blocking exclusive advisory lock on f.
// The lock is owned by the process, so the OS releases it automatically if the
// holder dies — it can never outlive a crashed refresh.
func acquireAuthGuard(f *os.File) error {
	return unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB)
}

// authGuardContended reports whether an acquireAuthGuard failure means another
// process holds the lock, which is the only case worth retrying.
func authGuardContended(err error) bool {
	return errors.Is(err, unix.EWOULDBLOCK) || errors.Is(err, unix.EAGAIN)
}

// releaseAuthGuard unlocks f.
func releaseAuthGuard(f *os.File) error {
	return unix.Flock(int(f.Fd()), unix.LOCK_UN)
}
