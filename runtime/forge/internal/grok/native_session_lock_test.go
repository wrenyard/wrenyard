package grok

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/usage/quota"
)

func TestNativeSessionLiveOldLockCannotBeStolenAndIgnoresQuotaTimeout(t *testing.T) {
	lockPath := filepath.Join(t.TempDir(), "locks", "session.lock")
	lock, err := acquireNativeSessionLockOnce(lockPath)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	old := time.Now().Add(-24 * time.Hour)
	if err := os.Chtimes(lockPath, old, old); err != nil {
		t.Fatal(err)
	}
	quota.SetRefreshLockStaleTimeout(time.Nanosecond)
	defer quota.SetRefreshLockStaleTimeout(2 * time.Minute)

	if stolen, err := acquireNativeSessionLockOnce(lockPath); err == nil {
		stolen.Release()
		t.Fatal("live native-session lock was stolen after age/quota timeout mutation")
	}
	if !lock.CheckOwnership() {
		t.Fatal("live old owner lost its nonce-protected ownership")
	}
}

func TestNativeSessionProvablyDeadOwnerIsRecovered(t *testing.T) {
	pid := exitedProcessPID(t)
	if state := nativeSessionOwnerLiveness(pid); state != nativeSessionOwnerDead {
		t.Fatalf("exited process %d liveness=%d, want dead", pid, state)
	}
	lockPath := filepath.Join(t.TempDir(), "locks", "session.lock")
	if err := ensurePrivateDirectory(filepath.Dir(lockPath)); err != nil {
		t.Fatal(err)
	}
	deadOwner := nativeSessionLockOwner{PID: pid, Nonce: "0123456789abcdef"}
	if err := writeNativeSessionLockOwner(lockPath, deadOwner); err != nil {
		t.Fatal(err)
	}
	lock, err := acquireNativeSessionLockOnce(lockPath)
	if err != nil {
		t.Fatalf("recover provably dead owner: %v", err)
	}
	defer lock.Release()
	if lock.owner == deadOwner || !lock.CheckOwnership() {
		t.Fatalf("dead-owner recovery did not install a fresh nonce: %+v", lock.owner)
	}
}

func TestNativeSessionUnknownOwnerLivenessFailsClosed(t *testing.T) {
	lockPath := filepath.Join(t.TempDir(), "locks", "session.lock")
	if err := ensurePrivateDirectory(filepath.Dir(lockPath)); err != nil {
		t.Fatal(err)
	}
	owner := nativeSessionLockOwner{PID: 424242, Nonce: "abcdef0123456789"}
	if err := writeNativeSessionLockOwner(lockPath, owner); err != nil {
		t.Fatal(err)
	}
	oldLiveness := nativeSessionProcessLiveness
	nativeSessionProcessLiveness = func(int) nativeSessionOwnerState { return nativeSessionOwnerUnknown }
	defer func() { nativeSessionProcessLiveness = oldLiveness }()
	if lock, err := acquireNativeSessionLockOnce(lockPath); err == nil {
		lock.Release()
		t.Fatal("unknown owner liveness was stolen")
	} else if !strings.Contains(err.Error(), "liveness is unknown") {
		t.Fatalf("unknown-liveness error = %v", err)
	}
}

func TestNativeSessionLockSerializesConcurrentRefreshOwnership(t *testing.T) {
	lockPath := filepath.Join(t.TempDir(), "locks", "session.lock")
	first, err := acquireNativeSessionLock(lockPath)
	if err != nil {
		t.Fatal(err)
	}
	type result struct {
		lock *nativeSessionLock
		err  error
	}
	done := make(chan result, 1)
	go func() {
		lock, err := acquireNativeSessionLock(lockPath)
		done <- result{lock: lock, err: err}
	}()
	select {
	case acquired := <-done:
		if acquired.lock != nil {
			acquired.lock.Release()
		}
		t.Fatalf("concurrent owner did not serialize: %v", acquired.err)
	case <-time.After(50 * time.Millisecond):
	}
	first.Release()
	select {
	case acquired := <-done:
		if acquired.err != nil {
			t.Fatal(acquired.err)
		}
		acquired.lock.Release()
	case <-time.After(2 * time.Second):
		t.Fatal("serialized native-session owner never acquired")
	}
}

func TestNativeSessionRefreshErrorReleasesOwnedLock(t *testing.T) {
	dataDir := t.TempDir()
	nativeID := "error-release-native-session"
	runHome, _ := writeNativeSessionFixture(t, nativeID, t.TempDir(), "state", false)
	target, err := NativeSessionSnapshotPath(dataDir, nativeID)
	if err != nil {
		t.Fatal(err)
	}
	if err := ensurePrivateDirectory(filepath.Dir(target)); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte("invalid existing target"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := RefreshNativeSessionSnapshot(dataDir, runHome, nativeID); err == nil {
		t.Fatal("refresh unexpectedly accepted a non-directory target")
	}
	lockPath := filepath.Join(filepath.Dir(target), ".locks", filepath.Base(target)+".lock")
	lock, err := acquireNativeSessionLockOnce(lockPath)
	if err != nil {
		t.Fatalf("refresh error retained owned lock: %v", err)
	}
	lock.Release()
}

func TestNativeSessionCrashedOwnerLockIsRecoverable(t *testing.T) {
	lockPath := filepath.Join(t.TempDir(), "locks", "session.lock")
	cmd := exec.Command(os.Args[0], "-test.run=^TestNativeSessionLockHelperProcess$")
	cmd.Env = append(os.Environ(), "FORGE_NATIVE_SESSION_LOCK_HELPER=1", "FORGE_NATIVE_SESSION_LOCK_PATH="+lockPath)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil || strings.TrimSpace(line) != "ready" {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		t.Fatalf("lock helper readiness=%q err=%v", line, err)
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Wait(); err == nil {
		t.Fatal("killed lock helper exited successfully")
	}
	lock, err := acquireNativeSessionLock(lockPath)
	if err != nil {
		t.Fatalf("recover crashed lock helper: %v", err)
	}
	lock.Release()
}

func TestNativeSessionLockHelperProcess(t *testing.T) {
	if os.Getenv("FORGE_NATIVE_SESSION_LOCK_HELPER") != "1" {
		return
	}
	lock, err := acquireNativeSessionLock(os.Getenv("FORGE_NATIVE_SESSION_LOCK_PATH"))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	defer lock.Release()
	fmt.Println("ready")
	select {}
}

func exitedProcessPID(t *testing.T) int {
	t.Helper()
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("cmd.exe", "/d", "/s", "/c", "exit /b 0")
	} else {
		cmd = exec.Command("sh", "-c", "exit 0")
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	pid := cmd.Process.Pid
	if err := cmd.Wait(); err != nil {
		t.Fatal(err)
	}
	return pid
}
