//go:build !windows

package grok

import (
	"errors"
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

func acquireNativeSessionGuardNB(file *os.File) error {
	return unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB)
}

func releaseNativeSessionGuard(file *os.File) error {
	return unix.Flock(int(file.Fd()), unix.LOCK_UN)
}

func nativeSessionOwnerLiveness(pid int) nativeSessionOwnerState {
	if pid <= 0 {
		return nativeSessionOwnerUnknown
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return nativeSessionOwnerUnknown
	}
	err = process.Signal(syscall.Signal(0))
	switch {
	case err == nil, errors.Is(err, syscall.EPERM):
		return nativeSessionOwnerAlive
	case errors.Is(err, syscall.ESRCH), errors.Is(err, os.ErrProcessDone):
		return nativeSessionOwnerDead
	default:
		return nativeSessionOwnerUnknown
	}
}
