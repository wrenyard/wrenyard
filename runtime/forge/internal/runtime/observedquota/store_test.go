package observedquota

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestWriteReadRoundTrip(t *testing.T) {
	root := t.TempDir()
	now := time.Date(2026, 8, 30, 10, 0, 0, 0, time.UTC)
	resetsAt := NextLocalMonthStart(now)
	store := NewStore(root)

	record := MonthlyExhaustion(ProviderCodeBuddy, now, resetsAt)
	if !store.Write(record) {
		t.Fatal("write must succeed for a valid record")
	}
	got, ok := store.Read(ProviderCodeBuddy)
	if !ok {
		t.Fatal("read must succeed after write")
	}
	if got.Provider != ProviderCodeBuddy || !got.Exhausted {
		t.Fatalf("record=%+v", got)
	}
	if !got.ObservedAt.Equal(now) || !got.ResetsAt.Equal(resetsAt) {
		t.Fatalf("record timestamps=%+v want observed=%v resets=%v", got, now, resetsAt)
	}
	if got.ReasonCode != ReasonMonthlyQuotaExhausted || got.SchemaVersion != SchemaVersion {
		t.Fatalf("record=%+v", got)
	}
}

func TestRecordExpiresAtNextLocalMonthStart(t *testing.T) {
	root := t.TempDir()
	now := time.Date(2026, 8, 30, 10, 0, 0, 0, time.Local)
	store := NewStore(root)

	resetsAt := NextLocalMonthStart(now)
	want := time.Date(2026, 9, 1, 0, 0, 0, 0, time.Local).UTC()
	if !resetsAt.Equal(want) {
		t.Fatalf("NextLocalMonthStart(%v)=%v want %v", now, resetsAt, want)
	}

	if !store.Write(MonthlyExhaustion(ProviderCodeBuddy, now, resetsAt)) {
		t.Fatal("write must succeed")
	}
	if _, ok := store.Active(ProviderCodeBuddy, resetsAt.Add(-time.Second)); !ok {
		t.Fatal("record must be active strictly before resets_at")
	}
	if _, ok := store.Active(ProviderCodeBuddy, resetsAt); ok {
		t.Fatal("record must stop projecting exactly at resets_at")
	}
	if _, ok := store.Active(ProviderCodeBuddy, resetsAt.Add(time.Minute)); ok {
		t.Fatal("record must stop projecting after resets_at")
	}
}

func TestReadFailsOpenOnCorruption(t *testing.T) {
	root := t.TempDir()
	store := NewStore(root)

	// Malformed JSON, unknown fields, and wrong schema version all fail open.
	for name, content := range map[string]string{
		"garbage":        `{not json`,
		"unknown key":    `{"schema_version":1,"provider":"codebuddy","exhausted":true,"observed_at":"2026-08-30T10:00:00Z","resets_at":"2026-09-01T00:00:00Z","reason_code":"monthly_quota_exhausted","model":"secret-model"}`,
		"trailing json":  `{"schema_version":1,"provider":"codebuddy","exhausted":true,"observed_at":"2026-08-30T10:00:00Z","resets_at":"2026-09-01T00:00:00Z","reason_code":"monthly_quota_exhausted"}{}`,
		"wrong provider": `{"schema_version":1,"provider":"other","exhausted":true,"observed_at":"2026-08-30T10:00:00Z","resets_at":"2026-09-01T00:00:00Z","reason_code":"monthly_quota_exhausted"}`,
		"wrong version":  `{"schema_version":99,"provider":"codebuddy","exhausted":true,"observed_at":"2026-08-30T10:00:00Z","resets_at":"2026-09-01T00:00:00Z","reason_code":"monthly_quota_exhausted"}`,
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(root, "codebuddy.json")
			if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
			if record, ok := store.Read(ProviderCodeBuddy); ok {
				t.Fatalf("corrupt record read unexpectedly: %+v", record)
			}
			if _, ok := store.Active(ProviderCodeBuddy, time.Now()); ok {
				t.Fatal("corrupt record must never project as active")
			}
			os.Remove(path)
		})
	}

	// Missing file fails open too.
	if _, ok := store.Read("missing-provider"); ok {
		t.Fatal("missing record must fail open")
	}
}

func TestRecordPrivacyShape(t *testing.T) {
	now := time.Date(2026, 8, 30, 10, 0, 0, 0, time.UTC)
	record := MonthlyExhaustion(ProviderCodeBuddy, now, NextLocalMonthStart(now))
	data, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	var keys []string
	var shape map[string]json.RawMessage
	if err := json.Unmarshal(data, &shape); err != nil {
		t.Fatal(err)
	}
	for key := range shape {
		keys = append(keys, key)
	}
	allowed := map[string]bool{
		"schema_version": true, "provider": true, "exhausted": true,
		"observed_at": true, "resets_at": true, "reason_code": true,
	}
	if len(keys) != len(allowed) {
		t.Fatalf("record keys=%v must be exactly %v", keys, allowed)
	}
	for key := range shape {
		if !allowed[key] {
			t.Fatalf("record must not contain key %q", key)
		}
	}
	text := string(data)
	for _, forbidden := range []string{"error", "model", "profile", "session", "credential", "auth", "command", "prompt", "token"} {
		if strings.Contains(strings.ToLower(text), forbidden) {
			t.Fatalf("record leaks privacy-sensitive field %q: %s", forbidden, text)
		}
	}
}

func TestRootOverrideIsolation(t *testing.T) {
	rootA := t.TempDir()
	rootB := t.TempDir()
	now := time.Date(2026, 8, 30, 10, 0, 0, 0, time.UTC)
	resetsAt := NextLocalMonthStart(now)

	storeA := NewStore(rootA)
	storeB := NewStore(rootB)
	if !storeA.Write(MonthlyExhaustion(ProviderCodeBuddy, now, resetsAt)) {
		t.Fatal("write to root A must succeed")
	}
	if _, ok := storeB.Read(ProviderCodeBuddy); ok {
		t.Fatal("root B must not observe root A state")
	}
	if _, ok := storeA.Read(ProviderCodeBuddy); !ok {
		t.Fatal("root A must retain its own state")
	}
}

func TestInvalidRecordsAreRejected(t *testing.T) {
	root := t.TempDir()
	store := NewStore(root)
	now := time.Date(2026, 8, 30, 10, 0, 0, 0, time.UTC)
	resetsAt := NextLocalMonthStart(now)

	for name, record := range map[string]Record{
		"not exhausted":  {SchemaVersion: SchemaVersion, Provider: ProviderCodeBuddy, Exhausted: false, ObservedAt: now, ResetsAt: resetsAt, ReasonCode: ReasonMonthlyQuotaExhausted},
		"wrong version":  {SchemaVersion: 99, Provider: ProviderCodeBuddy, Exhausted: true, ObservedAt: now, ResetsAt: resetsAt, ReasonCode: ReasonMonthlyQuotaExhausted},
		"empty provider": {SchemaVersion: SchemaVersion, Exhausted: true, ObservedAt: now, ResetsAt: resetsAt, ReasonCode: ReasonMonthlyQuotaExhausted},
		"no reason":      {SchemaVersion: SchemaVersion, Provider: ProviderCodeBuddy, Exhausted: true, ObservedAt: now, ResetsAt: resetsAt},
		"wrong reason":   {SchemaVersion: SchemaVersion, Provider: ProviderCodeBuddy, Exhausted: true, ObservedAt: now, ResetsAt: resetsAt, ReasonCode: "other"},
		"invalid reset":  {SchemaVersion: SchemaVersion, Provider: ProviderCodeBuddy, Exhausted: true, ObservedAt: now, ResetsAt: now, ReasonCode: ReasonMonthlyQuotaExhausted},
		"path traversal": {SchemaVersion: SchemaVersion, Provider: "../escape", Exhausted: true, ObservedAt: now, ResetsAt: resetsAt, ReasonCode: ReasonMonthlyQuotaExhausted},
	} {
		t.Run(name, func(t *testing.T) {
			if store.Write(record) {
				t.Fatalf("invalid record %+v must be rejected", record)
			}
		})
	}
	if entries, err := os.ReadDir(root); err == nil && len(entries) != 0 {
		t.Fatalf("rejected writes must not create state files: %v", entries)
	}
}

func TestDefaultRootIsXDGAware(t *testing.T) {
	stateHome := filepath.Join(t.TempDir(), "state")
	t.Setenv("XDG_STATE_HOME", stateHome)
	root, err := DefaultRoot()
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(stateHome, "wrenyard", "runtime")
	if root != want {
		t.Fatalf("DefaultRoot()=%q want %q", root, want)
	}

	// Fallback to $HOME/.local/state when XDG_STATE_HOME is unset.
	t.Setenv("XDG_STATE_HOME", "")
	home := t.TempDir()
	t.Setenv("HOME", home)
	root, err = DefaultRoot()
	if err != nil {
		t.Fatal(err)
	}
	want = filepath.Join(home, ".local", "state", "wrenyard", "runtime")
	if root != want {
		t.Fatalf("DefaultRoot()=%q want %q", root, want)
	}
}

func TestAtomicWriteUsesMode0600(t *testing.T) {
	root := t.TempDir()
	now := time.Date(2026, 8, 30, 10, 0, 0, 0, time.UTC)
	store := NewStore(root)
	if !store.Write(MonthlyExhaustion(ProviderCodeBuddy, now, NextLocalMonthStart(now))) {
		t.Fatal("write must succeed")
	}
	info, err := os.Stat(filepath.Join(root, "codebuddy.json"))
	if err != nil {
		t.Fatal(err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Fatalf("record file mode=%o want 0600", mode)
	}
}
