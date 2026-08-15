package quota

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Tests for the guarded-ownership primitive (RefreshLock.WithOwnedGuard).
// These pin the semantics that make ownership verification and a protected
// file mutation atomic with respect to stale reclaim/new acquisition.

// TestRefreshLockWithOwnedGuardRunsCallbackWhileOwned verifies that the
// callback executes exactly once while the lock is owned and that the lock
// remains owned and releasable afterwards.
func TestRefreshLockWithOwnedGuardRunsCallbackWhileOwned(t *testing.T) {
	lockPath := filepath.Join(t.TempDir(), "test.lock")

	l1, err := AcquireRefreshLock(lockPath)
	if err != nil {
		t.Fatal(err)
	}

	marker := filepath.Join(t.TempDir(), "callback-ran")
	ran := false
	if err := l1.WithOwnedGuard(func() error {
		ran = true
		return os.WriteFile(marker, []byte("owned"), 0o600)
	}); err != nil {
		t.Fatalf("WithOwnedGuard error = %v, want nil", err)
	}
	if !ran {
		t.Fatal("callback must run while the lock is owned")
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("callback side effect missing: %v", err)
	}

	// The lock is still owned and releasable after the guarded callback.
	if !l1.CheckOwnership() {
		t.Fatal("lock must still be owned after WithOwnedGuard returns")
	}
	l1.Release()
	if _, err := os.Stat(lockPath); err == nil {
		t.Fatal("lockfile should be removed by Release after WithOwnedGuard")
	}
}

// TestRefreshLockWithOwnedGuardSkipsCallbackAfterReclaim verifies that a
// reclaimed token suppresses the callback and that the stale worker's Release
// is a strict no-op on the newer owner's token.
func TestRefreshLockWithOwnedGuardSkipsCallbackAfterReclaim(t *testing.T) {
	lockPath := filepath.Join(t.TempDir(), "test.lock")

	l1, err := AcquireRefreshLock(lockPath)
	if err != nil {
		t.Fatal(err)
	}

	// A newer owner reclaims the lock (token replacement).
	newToken := "99999-feedface"
	if err := os.WriteFile(lockPath, []byte(newToken+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	ran := false
	err = l1.WithOwnedGuard(func() error {
		ran = true
		return nil
	})
	if !errors.Is(err, ErrRefreshLockOwnershipLost) {
		t.Fatalf("WithOwnedGuard error = %v, want ErrRefreshLockOwnershipLost", err)
	}
	if ran {
		t.Fatal("callback must not run after the lock was reclaimed")
	}

	// The newer owner's token is not released by the stale worker.
	l1.Release()
	data, err := os.ReadFile(lockPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(data)) != newToken {
		t.Fatalf("lockfile = %q, want newer token %q (stale release must be a no-op)", strings.TrimSpace(string(data)), newToken)
	}
}

// TestRefreshLockWithOwnedGuardReleasesGuardAfterCallbackError verifies that
// a callback error is propagated and that the guard is released afterwards so
// the lock remains usable. The ownership re-checks run under a deadline so a
// leaked guard (which would block forever) fails the test in seconds instead
// of hanging until the Go 10-minute package timeout.
func TestRefreshLockWithOwnedGuardReleasesGuardAfterCallbackError(t *testing.T) {
	lockPath := filepath.Join(t.TempDir(), "test.lock")

	l1, err := AcquireRefreshLock(lockPath)
	if err != nil {
		t.Fatal(err)
	}

	cbErr := errors.New("callback failed")
	if err := l1.WithOwnedGuard(func() error { return cbErr }); !errors.Is(err, cbErr) {
		t.Fatalf("WithOwnedGuard error = %v, want the callback error", err)
	}

	// The guard must be released after the callback error: a fresh guard
	// acquisition must now succeed.
	if err := within(t, 5*time.Second, func() error {
		guard, err := openGuard(lockPath)
		if err != nil {
			return err
		}
		defer closeGuard(guard)
		return acquireGuard(guard)
	}); err != nil {
		t.Fatalf("guard must be released after callback error: %v", err)
	}

	// The lock remains owned; a normal Release still removes it.
	err = within(t, 5*time.Second, func() error {
		if !l1.CheckOwnership() {
			return errors.New("lock not owned")
		}
		return nil
	})
	if err != nil {
		t.Fatalf("lock must still be owned after callback error: %v", err)
	}
	l1.Release()
	if _, err := os.Stat(lockPath); err == nil {
		t.Fatal("lockfile should be removed by Release after callback error")
	}
}

// within runs fn in a goroutine and returns its error, or a timeout error if
// fn has not returned within d. It makes a leaked guard — which surfaces as a
// permanently blocked lock acquisition — fail fast in seconds rather than
// waiting for the Go package test timeout.
func within(t *testing.T, d time.Duration, fn func() error) error {
	t.Helper()
	done := make(chan error, 1)
	go func() {
		done <- fn()
	}()
	select {
	case err := <-done:
		return err
	case <-time.After(d):
		return errors.New("timed out: operation blocked (guard not released?)")
	}
}

// TestRefreshLockWithOwnedGuardMutualExclusionWithStaleReclaim verifies that
// a stale reclaim cannot proceed while the guarded callback holds the guard,
// and that it succeeds exactly once after the callback releases it.
func TestRefreshLockWithOwnedGuardMutualExclusionWithStaleReclaim(t *testing.T) {
	lockPath := filepath.Join(t.TempDir(), "test.lock")

	// Short stale timeout so the lock is reclaimable once the guard is free.
	SetRefreshLockStaleTimeout(50 * time.Millisecond)
	defer SetRefreshLockStaleTimeout(2 * time.Minute)

	l1, err := AcquireRefreshLock(lockPath)
	if err != nil {
		t.Fatal(err)
	}

	guardHeld := make(chan struct{})
	releaseCallback := make(chan struct{})
	cbDone := make(chan error, 1)
	go func() {
		cbDone <- l1.WithOwnedGuard(func() error {
			close(guardHeld) // the guard is held here
			<-releaseCallback
			return nil
		})
	}()

	// Wait until the guarded callback owns the guard.
	<-guardHeld

	// Backdate the lockfile so a stale reclaim is eligible once the guard
	// is released.
	past := time.Now().Add(-10 * time.Minute)
	if err := os.Chtimes(lockPath, past, past); err != nil {
		t.Fatal(err)
	}

	// While the guard is held, a stale reclaim must be refused: the guarded
	// callback and the reclaimer cannot both hold the guard.
	if _, err := AcquireRefreshLock(lockPath); err == nil {
		close(releaseCallback)
		<-cbDone
		l1.Release()
		t.Fatal("stale reclaim must not succeed while WithOwnedGuard holds the guard")
	}

	// Release the guard; the reclaim can now proceed exactly once.
	close(releaseCallback)
	if err := <-cbDone; err != nil {
		t.Fatal(err)
	}

	l2, err := AcquireRefreshLock(lockPath)
	if err != nil {
		t.Fatalf("stale reclaim should succeed after the guarded callback released the guard: %v", err)
	}
	if l2.Token == l1.Token {
		t.Fatal("reclaimed lock must carry a new token")
	}
	l2.Release()
}
