package grok

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type nativeSessionOwnerState uint8

const (
	nativeSessionOwnerUnknown nativeSessionOwnerState = iota
	nativeSessionOwnerAlive
	nativeSessionOwnerDead
)

type nativeSessionLockOwner struct {
	PID   int    `json:"pid"`
	Nonce string `json:"nonce"`
}

type grokLifecycleLock struct {
	path  string
	owner nativeSessionLockOwner
	guard *os.File
}

type nativeSessionLock = grokLifecycleLock

var nativeSessionProcessLiveness = nativeSessionOwnerLiveness

func acquireNativeSessionLock(lockPath string) (*nativeSessionLock, error) {
	var lastErr error
	deadline := time.Now().Add(10 * time.Second)
	for attempt := 0; ; attempt++ {
		lock, err := acquireNativeSessionLockOnce(lockPath)
		if err == nil {
			return lock, nil
		}
		lastErr = err
		if time.Now().After(deadline) {
			break
		}
		delay := time.Duration(attempt+1) * 10 * time.Millisecond
		if delay > 100*time.Millisecond {
			delay = 100 * time.Millisecond
		}
		time.Sleep(delay)
	}
	return nil, fmt.Errorf("snapshot lock remained busy: %w", lastErr)
}

func acquireNativeSessionLockOnce(lockPath string) (*nativeSessionLock, error) {
	return acquireGrokLifecycleLockOnce(lockPath)
}

func acquireGrokLifecycleLockOnce(lockPath string) (*grokLifecycleLock, error) {
	lockPath = filepath.Clean(strings.TrimSpace(lockPath))
	if lockPath == "." || filepath.Base(lockPath) == "." || filepath.Base(lockPath) == string(filepath.Separator) {
		return nil, fmt.Errorf("native session lock path is invalid")
	}
	parent := filepath.Dir(lockPath)
	if err := ensurePrivateDirectory(parent); err != nil {
		return nil, fmt.Errorf("create native session lock directory: %w", err)
	}
	guardPath := lockPath + ".guard"
	if info, err := os.Lstat(guardPath); err == nil && (info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular()) {
		return nil, fmt.Errorf("native session lock guard is invalid")
	} else if err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("inspect native session lock guard: %w", err)
	}
	guard, err := os.OpenFile(guardPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open native session lock guard: %w", err)
	}
	if err := acquireNativeSessionGuardNB(guard); err != nil {
		_ = guard.Close()
		return nil, fmt.Errorf("native session lock is busy: %w", err)
	}
	owned := false
	defer func() {
		if !owned {
			_ = releaseNativeSessionGuard(guard)
			_ = guard.Close()
		}
	}()

	existing, exists, err := readNativeSessionLockOwner(lockPath)
	if err != nil {
		return nil, err
	}
	if exists {
		switch nativeSessionProcessLiveness(existing.PID) {
		case nativeSessionOwnerAlive:
			return nil, fmt.Errorf("native session lock is owned by a live process")
		case nativeSessionOwnerUnknown:
			return nil, fmt.Errorf("native session lock owner liveness is unknown")
		case nativeSessionOwnerDead:
			if err := os.Remove(lockPath); err != nil && !os.IsNotExist(err) {
				return nil, fmt.Errorf("remove crashed native session lock owner: %w", err)
			}
		}
	}

	owner := nativeSessionLockOwner{PID: os.Getpid(), Nonce: makeNativeSessionNonce()}
	if owner.Nonce == "" {
		return nil, fmt.Errorf("create native session lock owner nonce")
	}
	if err := writeNativeSessionLockOwner(lockPath, owner); err != nil {
		return nil, err
	}
	owned = true
	return &grokLifecycleLock{path: lockPath, owner: owner, guard: guard}, nil
}

func (lock *grokLifecycleLock) Release() {
	if lock == nil || lock.guard == nil {
		return
	}
	owner, exists, err := readNativeSessionLockOwner(lock.path)
	if err == nil && exists && owner == lock.owner {
		_ = os.Remove(lock.path)
	}
	_ = releaseNativeSessionGuard(lock.guard)
	_ = lock.guard.Close()
	lock.guard = nil
}

func (lock *grokLifecycleLock) CheckOwnership() bool {
	if lock == nil || lock.guard == nil {
		return false
	}
	owner, exists, err := readNativeSessionLockOwner(lock.path)
	return err == nil && exists && owner == lock.owner
}

func readNativeSessionLockOwner(lockPath string) (nativeSessionLockOwner, bool, error) {
	info, err := os.Lstat(lockPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nativeSessionLockOwner{}, false, nil
		}
		return nativeSessionLockOwner{}, false, fmt.Errorf("inspect native session lock owner: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return nativeSessionLockOwner{}, false, fmt.Errorf("native session lock owner is invalid")
	}
	data, err := os.ReadFile(lockPath)
	if err != nil {
		return nativeSessionLockOwner{}, false, fmt.Errorf("read native session lock owner: %w", err)
	}
	var owner nativeSessionLockOwner
	if json.Unmarshal(data, &owner) == nil && owner.PID > 0 && validNativeSessionNonce(owner.Nonce) {
		return owner, true, nil
	}
	// Forge 0.7.13 originally reused quota's "pid-nonce" lock token. Parse it
	// only for verified liveness recovery; new ownership is always JSON.
	legacy := strings.TrimSpace(string(data))
	pidText, nonce, ok := strings.Cut(legacy, "-")
	pid, parseErr := strconv.Atoi(pidText)
	if ok && parseErr == nil && pid > 0 && validNativeSessionNonce(nonce) {
		return nativeSessionLockOwner{PID: pid, Nonce: nonce}, true, nil
	}
	return nativeSessionLockOwner{}, false, fmt.Errorf("native session lock owner is invalid")
}

func writeNativeSessionLockOwner(lockPath string, owner nativeSessionLockOwner) error {
	data, err := json.Marshal(owner)
	if err != nil {
		return fmt.Errorf("encode native session lock owner: %w", err)
	}
	stage, err := os.CreateTemp(filepath.Dir(lockPath), ".owner-*")
	if err != nil {
		return fmt.Errorf("stage native session lock owner: %w", err)
	}
	stagePath := stage.Name()
	installed := false
	defer func() {
		_ = stage.Close()
		if !installed {
			_ = os.Remove(stagePath)
		}
	}()
	if err := stage.Chmod(0o600); err != nil {
		return fmt.Errorf("restrict native session lock owner: %w", err)
	}
	if _, err := stage.Write(append(data, '\n')); err != nil {
		return fmt.Errorf("write native session lock owner: %w", err)
	}
	if err := stage.Sync(); err != nil {
		return fmt.Errorf("sync native session lock owner: %w", err)
	}
	if err := stage.Close(); err != nil {
		return fmt.Errorf("close native session lock owner: %w", err)
	}
	if err := os.Rename(stagePath, lockPath); err != nil {
		return fmt.Errorf("install native session lock owner: %w", err)
	}
	installed = true
	return nil
}

func makeNativeSessionNonce() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return ""
	}
	return hex.EncodeToString(value[:])
}

func validNativeSessionNonce(value string) bool {
	if len(value) < 8 || len(value) > 128 {
		return false
	}
	for _, char := range value {
		if !(char >= '0' && char <= '9' || char >= 'a' && char <= 'f' || char >= 'A' && char <= 'F') {
			return false
		}
	}
	return true
}
