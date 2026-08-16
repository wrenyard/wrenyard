package execution

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

type testClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *testClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *testClock) Set(now time.Time) {
	c.mu.Lock()
	c.now = now
	c.mu.Unlock()
}

func TestCircuitStorePathAndPrivacy(t *testing.T) {
	root := t.TempDir()
	clock := &testClock{now: time.Date(2026, 7, 12, 6, 30, 0, 0, time.UTC)}
	store := NewCircuitStore(root, clock)
	profile := "profile-secret-name"
	opened := clock.Now()
	record := CircuitRecord{
		SchemaVersion:  1,
		ProfileHash:    profileHash(profile),
		State:          CircuitStateOpen,
		OpenedAt:       opened.Format(time.RFC3339),
		UnlockAt:       opened.Add(time.Hour).Format(time.RFC3339),
		Classification: FailureClassTransientProvider,
		ReasonCode:     CircuitReasonRetryExhausted,
		RetryCount:     maxProfileRetries,
	}
	if !store.Write(profile, record) {
		t.Fatal("expected circuit record to persist")
	}

	wantHash := sha256.Sum256([]byte(profile))
	wantPath := filepath.Join(root, hex.EncodeToString(wantHash[:])+".json")
	if got := store.Path(profile); got != wantPath {
		t.Fatalf("path=%q want %q", got, wantPath)
	}

	data, err := os.ReadFile(wantPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), profile) {
		t.Fatalf("state leaked raw profile name: %s", data)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(root)
		if err != nil {
			t.Fatal(err)
		}
		if got := info.Mode().Perm(); got != 0o700 {
			t.Fatalf("root mode=%o want 700", got)
		}
		info, err = os.Stat(wantPath)
		if err != nil {
			t.Fatal(err)
		}
		if got := info.Mode().Perm(); got != 0o600 {
			t.Fatalf("record mode=%o want 600", got)
		}
	}

	check := store.Check(profile)
	if check.Record == nil || !check.Open {
		t.Fatalf("check=%+v want open record", check)
	}
}

func TestCircuitStoreCorruptStateFailsOpenAndExpires(t *testing.T) {
	root := t.TempDir()
	clock := &testClock{now: time.Date(2026, 7, 12, 6, 30, 0, 0, time.UTC)}
	store := NewCircuitStore(root, clock)
	profile := "cb-hy"
	path := store.Path(profile)
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"schema_version":99}`), 0o600); err != nil {
		t.Fatal(err)
	}
	check := store.Check(profile)
	if check.Open || !check.Corrupt {
		t.Fatalf("corrupt check=%+v want fail-open corrupt", check)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("corrupt record should be removed, stat err=%v", err)
	}

	opened := clock.Now()
	if !store.Write(profile, CircuitRecord{
		SchemaVersion:  1,
		ProfileHash:    profileHash(profile),
		State:          CircuitStateOpen,
		OpenedAt:       opened.Add(-time.Hour).Format(time.RFC3339),
		UnlockAt:       opened.Format(time.RFC3339),
		Classification: FailureClassTransientProvider,
		ReasonCode:     CircuitReasonStructuredRecovery,
	}) {
		t.Fatal("expected expired record to persist")
	}
	check = store.Check(profile)
	if check.Open || !check.Unlocked {
		t.Fatalf("expired check=%+v want unlocked closed", check)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("expired record should be removed, stat err=%v", err)
	}
}

func TestCircuitStoreConcurrentWritersLeaveCompleteRecord(t *testing.T) {
	root := t.TempDir()
	clock := &testClock{now: time.Date(2026, 7, 12, 6, 30, 0, 0, time.UTC)}
	store := NewCircuitStore(root, clock)
	profile := "same-profile"

	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			record := CircuitRecord{
				SchemaVersion:  1,
				ProfileHash:    profileHash(profile),
				State:          CircuitStateOpen,
				OpenedAt:       clock.Now().Format(time.RFC3339),
				UnlockAt:       clock.Now().Add(time.Duration(i+1) * time.Hour).Format(time.RFC3339),
				Classification: FailureClassTransientProvider,
				ReasonCode:     CircuitReasonRetryExhausted,
				RetryCount:     maxProfileRetries,
			}
			if !store.Write(profile, record) {
				t.Errorf("writer %d failed to persist", i)
			}
		}()
	}
	wg.Wait()

	check := store.Check(profile)
	if !check.Open || check.Record == nil {
		t.Fatalf("concurrent final check=%+v want complete open record", check)
	}
	if check.Record.ProfileHash != profileHash(profile) || check.Record.SchemaVersion != 1 {
		t.Fatalf("invalid final record=%+v", check.Record)
	}
}

func TestCircuitLockReclaimsStaleLock(t *testing.T) {
	root := t.TempDir()
	clock := &testClock{now: time.Date(2026, 7, 12, 6, 30, 0, 0, time.UTC)}
	store := NewCircuitStore(root, clock)
	if !store.ensureRoot() {
		t.Fatal("create circuit root")
	}
	lockPath := filepath.Join(root, profileHash("stale")+".lock")
	if err := os.WriteFile(lockPath, []byte("old-token\n123\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-time.Minute)
	if err := os.Chtimes(lockPath, old, old); err != nil {
		t.Fatal(err)
	}
	check := store.Check("stale")
	if check.Open || check.Corrupt || check.Unlocked {
		t.Fatalf("stale lock check=%+v want closed", check)
	}
	if _, err := os.Stat(lockPath); !os.IsNotExist(err) {
		t.Fatalf("stale lock remains, err=%v", err)
	}
}

func TestCircuitLockReleaseDoesNotDeleteNewOwner(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "profile.lock")
	lock, ok := acquireCircuitLock(path)
	if !ok {
		t.Fatal("acquire lock")
	}
	if err := os.WriteFile(path, []byte("new-owner\n123\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	lock.release()
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("token mismatch removed new owner lock: %v", err)
	}
	_ = os.Remove(path)
}

func TestCircuitStoreHardProfileLimitRecordValidation(t *testing.T) {
	root := t.TempDir()
	clock := &testClock{now: time.Date(2026, 7, 12, 6, 30, 0, 0, time.UTC)}
	store := NewCircuitStore(root, clock)
	profile := "cc-kimi"
	opened := clock.Now()

	record := CircuitRecord{
		SchemaVersion:  1,
		ProfileHash:    profileHash(profile),
		State:          CircuitStateOpen,
		OpenedAt:       opened.Format(time.RFC3339),
		UnlockAt:       opened.Add(time.Hour).Format(time.RFC3339),
		Classification: FailureClassProfileSpecificLimit,
		ReasonCode:     CircuitReasonHardProfileLimit,
		RetryCount:     0,
	}
	if !store.Write(profile, record) {
		t.Fatal("expected hard_profile_limit record with retry_count=0 to persist")
	}
	if check := store.Check(profile); !check.Open || check.Record.ReasonCode != CircuitReasonHardProfileLimit || check.Record.RetryCount != 0 {
		t.Fatalf("check=%+v want open hard_profile_limit retry_count=0 record", check)
	}

	// Negative counts and counts beyond the sane maximum must be rejected
	// without invalidating the previously persisted record.
	for _, retryCount := range []int{-1, maxProfileRetries + 1} {
		bad := record
		bad.RetryCount = retryCount
		if NewCircuitStore(root, clock).Write(profile, bad) {
			t.Fatalf("retry_count=%d must be rejected", retryCount)
		}
	}
	if check := store.Check(profile); !check.Open || check.Record.RetryCount != 0 {
		t.Fatalf("rejected invalid writes corrupted the record: %+v", check)
	}
}

func TestDefaultCircuitRootUnderWrenyardRuntimeHonorsXDGStateHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_STATE_HOME", filepath.Join(home, "xdg-state"))

	if got := DefaultCircuitRoot(); got != filepath.Join(home, "xdg-state", "wrenyard", "runtime", "circuits") {
		t.Fatalf("DefaultCircuitRoot() = %q, want XDG_STATE_HOME-resolved root", got)
	}

	t.Setenv("XDG_STATE_HOME", "")
	if got := DefaultCircuitRoot(); got != filepath.Join(home, ".local", "state", "wrenyard", "runtime", "circuits") {
		t.Fatalf("DefaultCircuitRoot() = %q, want default state root", got)
	}
}
