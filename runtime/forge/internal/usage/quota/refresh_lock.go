package quota

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// refreshLockStaleTimeout is the age after which a refresh lockfile is
// considered stale and may be reclaimed. Package-level so tests can
// inject a shorter value.
var refreshLockStaleTimeout = 2 * time.Minute

// SetRefreshLockStaleTimeout sets the refresh lock stale timeout. Used by tests.
func SetRefreshLockStaleTimeout(d time.Duration) {
	refreshLockStaleTimeout = d
}

// RefreshLock is a simple cross-process single-flight lock for background
// quota refresh subprocesses.
type RefreshLock struct {
	path  string
	Token string // exported for spawner token passing
}

// guardPath returns the sidecar guard file path for a lock path.
func guardPath(lockPath string) string {
	return lockPath + ".guard"
}

// openGuard opens (or creates) the sidecar guard file. The caller must
// call closeGuard on the returned file.
func openGuard(lockPath string) (*os.File, error) {
	return os.OpenFile(guardPath(lockPath), os.O_CREATE|os.O_RDWR, 0o600)
}

// closeGuard releases the OS lock and closes the guard file.
func closeGuard(f *os.File) {
	if f != nil {
		_ = releaseGuard(f)
		_ = f.Close()
	}
}

// AcquireRefreshLock attempts to create a refresh lockfile at lockPath.
// If the lock is already held (and not stale) or the sidecar guard is
// contended it returns an error so the caller can skip spawning a
// refresh subprocess.
//
// On success the caller MUST call RefreshLock.Release().
func AcquireRefreshLock(lockPath string) (*RefreshLock, error) {
	return acquireRefreshLock(lockPath, refreshLockStaleTimeout)
}

func acquireRefreshLock(lockPath string, staleTimeout time.Duration) (*RefreshLock, error) {
	token := makeRefreshToken()

	// Ensure parent directory exists — on a fresh machine the quota/
	// dir may not have been created yet. Must happen before OpenFile
	// so the O_CREATE|O_EXCL flag can create the lockfile.
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o700); err != nil {
		return nil, err
	}

	// Acquire the non-blocking OS sidecar guard. The guard serializes
	// all canonical-path transitions (create, stale reclaim, token
	// write, cleanup) and prevents the ABA race where a stale-owner
	// read of its own token could race with a new owner's replacement.
	guard, err := openGuard(lockPath)
	if err != nil {
		return nil, err
	}

	if err := acquireGuardNB(guard); err != nil {
		guard.Close()
		return nil, err // guard or lock held by another process
	}
	defer closeGuard(guard)

	f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		if os.IsExist(err) {
			if info, statErr := os.Stat(lockPath); statErr == nil &&
				time.Since(info.ModTime()) > staleTimeout {
				// Stale lock from a dead subprocess — reclaim via atomic rename.
				// os.Rename on the same volume is atomic: only one competitor
				// wins the race; the loser's Rename fails because the source
				// no longer exists, so they fall through to the outer err check
				// and return the lock-busy error cleanly.
				reclaimName := lockPath + ".reclaim." + token
				if rerr := os.Rename(lockPath, reclaimName); rerr == nil {
					_ = os.Remove(reclaimName)
					token = makeRefreshToken()
					f, err = os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
				}
			}
		}
	}
	if err != nil {
		return nil, err
	}

	_, writeErr := fmt.Fprintf(f, "%s\n", token)
	closeErr := f.Close()
	if writeErr != nil {
		_ = os.Remove(lockPath)
		return nil, writeErr
	}
	if closeErr != nil {
		_ = os.Remove(lockPath)
		return nil, closeErr
	}

	return &RefreshLock{path: lockPath, Token: token}, nil
}

// Release removes the lockfile ONLY if the token matches. If another
// process has claimed the lock (should not happen), the file is left alone.
// On any read error (unreadable, nonexistent, etc.) this is a strict no-op.
func (l *RefreshLock) Release() {
	guard, err := openGuard(l.path)
	if err != nil {
		return
	}

	// Acquire the guard in blocking mode so token read/compare/remove
	// and stale replacement cannot interleave.
	if err := acquireGuard(guard); err != nil {
		guard.Close()
		return
	}
	defer closeGuard(guard)

	data, err := os.ReadFile(l.path)
	if err != nil {
		return
	}
	if strings.TrimSpace(string(data)) == l.Token {
		_ = os.Remove(l.path)
	}
}

// CheckOwnership returns true if this lock still owns the lockfile.
func (l *RefreshLock) CheckOwnership() bool {
	guard, err := openGuard(l.path)
	if err != nil {
		return false
	}

	if err := acquireGuard(guard); err != nil {
		guard.Close()
		return false
	}
	defer closeGuard(guard)

	data, err := os.ReadFile(l.path)
	if err != nil {
		return false
	}
	return strings.TrimSpace(string(data)) == l.Token
}

// ErrRefreshLockOwnershipLost is returned by WithOwnedGuard when the
// lockfile token no longer matches — the lock was reclaimed by a newer owner.
// Callers must not perform the protected mutation and must not release a
// token they no longer own.
var ErrRefreshLockOwnershipLost = errors.New("refresh lock ownership lost")

// WithOwnedGuard verifies that this lock still owns the lockfile and, while
// holding the existing sidecar guard, executes fn. It makes ownership
// verification and the protected mutation atomic with respect to stale
// reclaim and new acquisition: a competing reclaimer blocks on the guard
// until fn returns, so a resumed stale worker cannot overwrite a newer
// owner's state. If the lockfile token no longer matches, fn is not executed
// and ErrRefreshLockOwnershipLost is returned. The guard is always released.
func (l *RefreshLock) WithOwnedGuard(fn func() error) error {
	guard, err := openGuard(l.path)
	if err != nil {
		return err
	}

	if err := acquireGuard(guard); err != nil {
		guard.Close()
		return err
	}
	defer closeGuard(guard)

	data, err := os.ReadFile(l.path)
	if err != nil {
		return ErrRefreshLockOwnershipLost
	}
	if strings.TrimSpace(string(data)) != l.Token {
		return ErrRefreshLockOwnershipLost
	}
	return fn()
}

// makeRefreshToken creates a unique token: "<pid>-<8 random hex chars>".
func makeRefreshToken() string {
	var b [4]byte
	_, _ = rand.Read(b[:])
	return fmt.Sprintf("%d-%s", os.Getpid(), hex.EncodeToString(b[:]))
}
