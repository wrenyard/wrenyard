package observedquota

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeRawState(t *testing.T, root, name, content string) {
	t.Helper()
	path := filepath.Join(root, name+".json")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestWriteReadScopedRoundTrip(t *testing.T) {
	root := t.TempDir()
	observedAt := time.Date(2026, 8, 30, 10, 0, 0, 0, time.UTC)
	resetsAt := time.Date(2026, 9, 30, 0, 0, 0, 0, time.UTC)
	store := NewStore(root)

	record := ConfirmedExhaustion(ProviderCodeBuddy, "cbv1:scope-abc123", observedAt, resetsAt)
	if !store.Write(record) {
		t.Fatal("write must succeed for a valid scoped record")
	}
	got, ok := store.Read(ProviderCodeBuddy)
	if !ok {
		t.Fatal("read must succeed after write")
	}
	if got.SchemaVersion != SchemaVersion {
		t.Fatalf("schema version=%d want %d", got.SchemaVersion, SchemaVersion)
	}
	if got.Provider != ProviderCodeBuddy || !got.Exhausted {
		t.Fatalf("record=%+v", got)
	}
	if got.Scope != "cbv1:scope-abc123" {
		t.Fatalf("scope=%q", got.Scope)
	}
	if !got.ObservedAt.Equal(observedAt) || !got.ResetsAt.Equal(resetsAt) {
		t.Fatalf("record timestamps=%+v want observed=%v resets=%v", got, observedAt, resetsAt)
	}
	if got.ReasonCode != ReasonQuotaExhausted {
		t.Fatalf("reason code=%q want %q", got.ReasonCode, ReasonQuotaExhausted)
	}
}

func TestActiveScopedRequiresExactScopeMatch(t *testing.T) {
	root := t.TempDir()
	observedAt := time.Date(2026, 8, 30, 10, 0, 0, 0, time.UTC)
	resetsAt := time.Date(2026, 9, 30, 0, 0, 0, 0, time.UTC)
	store := NewStore(root)

	if !store.Write(ConfirmedExhaustion(ProviderCodeBuddy, "cbv1:scope-exact", observedAt, resetsAt)) {
		t.Fatal("write must succeed")
	}
	if _, ok := store.ActiveScoped(ProviderCodeBuddy, "cbv1:scope-exact", observedAt); !ok {
		t.Fatal("exact scope must be active before resets_at")
	}

	// A mismatched scope must stay inactive and leave the evidence file
	// byte-identical.
	path := filepath.Join(root, "codebuddy.json")
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := store.ActiveScoped(ProviderCodeBuddy, "cbv1:scope-other", observedAt); ok {
		t.Fatal("mismatched scope must not be active")
	}
	if _, ok := store.ActiveScoped(ProviderCodeBuddy, "", observedAt); ok {
		t.Fatal("empty scope must never be active")
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("inactive reads must not modify the evidence file")
	}
}

func TestActiveScopedExpiresAtAuthoritativeResetsAt(t *testing.T) {
	root := t.TempDir()
	observedAt := time.Date(2026, 8, 30, 10, 0, 0, 0, time.UTC)
	resetsAt := time.Date(2026, 9, 30, 0, 0, 0, 0, time.UTC)
	store := NewStore(root)

	if !store.Write(ConfirmedExhaustion(ProviderCodeBuddy, "cbv1:scope-exp", observedAt, resetsAt)) {
		t.Fatal("write must succeed")
	}
	if _, ok := store.ActiveScoped(ProviderCodeBuddy, "cbv1:scope-exp", resetsAt.Add(-time.Second)); !ok {
		t.Fatal("record must be active strictly before resets_at")
	}
	if _, ok := store.ActiveScoped(ProviderCodeBuddy, "cbv1:scope-exp", resetsAt); ok {
		t.Fatal("record must stop projecting exactly at resets_at")
	}
	if _, ok := store.ActiveScoped(ProviderCodeBuddy, "cbv1:scope-exp", resetsAt.Add(time.Minute)); ok {
		t.Fatal("record must stop projecting after resets_at")
	}

	// The same exact scope stays active across time within the window.
	if _, ok := store.ActiveScoped(ProviderCodeBuddy, "cbv1:scope-exp", observedAt); !ok {
		t.Fatal("record must be active at observed time")
	}
	if _, ok := store.ActiveScoped(ProviderCodeBuddy, "cbv1:scope-exp", observedAt.Add(time.Hour)); !ok {
		t.Fatal("same scope must remain active within the reset window")
	}
}

func TestLegacySchemaV1IsReadableButInert(t *testing.T) {
	root := t.TempDir()
	store := NewStore(root)
	writeRawState(t, root, ProviderCodeBuddy,
		`{"schema_version":1,"provider":"codebuddy","exhausted":true,"observed_at":"2026-08-30T10:00:00Z","resets_at":"2026-09-30T00:00:00Z","reason_code":"monthly_quota_exhausted"}`)

	path := filepath.Join(root, "codebuddy.json")
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	record, ok := store.Read(ProviderCodeBuddy)
	if !ok {
		t.Fatal("legacy schema-v1 monthly record must parse strictly through Read")
	}
	if record.SchemaVersion != 1 || record.Scope != "" {
		t.Fatalf("legacy record=%+v", record)
	}
	if _, ok := store.ActiveScoped(ProviderCodeBuddy, "", time.Now()); ok {
		t.Fatal("legacy v1 record must never be active")
	}
	if _, ok := store.ActiveScoped(ProviderCodeBuddy, "cbv1:anything", time.Now()); ok {
		t.Fatal("legacy v1 record must never be active regardless of scope")
	}

	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("strict legacy reads must preserve the v1 evidence byte-identically")
	}
}

func TestReadFailsOpenOnCorruption(t *testing.T) {
	root := t.TempDir()
	store := NewStore(root)

	observed := "2026-08-30T10:00:00Z"
	resets := "2026-09-30T00:00:00Z"
	base := func(extra string) string {
		return `{"schema_version":2,"provider":"codebuddy","exhausted":true,"scope":"cbv1:ab","observed_at":"` +
			observed + `","resets_at":"` + resets + `","reason_code":"quota_exhausted"` + extra + `}`
	}
	for name, content := range map[string]string{
		"garbage":       `{not json`,
		"unknown key":   base(`,"model":"secret-model"`),
		"trailing json": base(``) + `{}`,
		"wrong provider": `{"schema_version":2,"provider":"other","exhausted":true,"scope":"cbv1:ab","observed_at":"` +
			observed + `","resets_at":"` + resets + `","reason_code":"quota_exhausted"}`,
		"wrong version": `{"schema_version":99,"provider":"codebuddy","exhausted":true,"scope":"cbv1:ab","observed_at":"` +
			observed + `","resets_at":"` + resets + `","reason_code":"quota_exhausted"}`,
		"empty scope": `{"schema_version":2,"provider":"codebuddy","exhausted":true,"scope":"","observed_at":"` +
			observed + `","resets_at":"` + resets + `","reason_code":"quota_exhausted"}`,
		"no scope": `{"schema_version":2,"provider":"codebuddy","exhausted":true,"observed_at":"` +
			observed + `","resets_at":"` + resets + `","reason_code":"quota_exhausted"}`,
		"wrong reason": `{"schema_version":2,"provider":"codebuddy","exhausted":true,"scope":"cbv1:ab","observed_at":"` +
			observed + `","resets_at":"` + resets + `","reason_code":"monthly_quota_exhausted"}`,
		"invalid time": `{"schema_version":2,"provider":"codebuddy","exhausted":true,"scope":"cbv1:ab","observed_at":"` +
			resets + `","resets_at":"` + observed + `","reason_code":"quota_exhausted"}`,
	} {
		t.Run(name, func(t *testing.T) {
			writeRawState(t, root, ProviderCodeBuddy, content)
			if record, ok := store.Read(ProviderCodeBuddy); ok {
				t.Fatalf("corrupt record read unexpectedly: %+v", record)
			}
			if _, ok := store.ActiveScoped(ProviderCodeBuddy, "cbv1:ab", time.Now()); ok {
				t.Fatal("corrupt record must never project as active")
			}
			os.Remove(filepath.Join(root, "codebuddy.json"))
		})
	}

	if _, ok := store.Read("missing-provider"); ok {
		t.Fatal("missing record must fail open")
	}
}

func TestRecordPrivacyShapeScoped(t *testing.T) {
	observedAt := time.Date(2026, 8, 30, 10, 0, 0, 0, time.UTC)
	resetsAt := time.Date(2026, 9, 30, 0, 0, 0, 0, time.UTC)
	record := ConfirmedExhaustion(ProviderCodeBuddy, "cbv1:ab12cd34", observedAt, resetsAt)
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
		"schema_version": true, "provider": true, "exhausted": true, "scope": true,
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
	for _, forbidden := range []string{
		"error", "model", "profile", "session", "credential", "auth", "command",
		"prompt", "token", "account", "domain", "identity",
	} {
		if strings.Contains(strings.ToLower(text), forbidden) {
			t.Fatalf("record leaks privacy-sensitive field %q: %s", forbidden, text)
		}
	}
}

func TestRootOverrideIsolation(t *testing.T) {
	rootA := t.TempDir()
	rootB := t.TempDir()
	observedAt := time.Date(2026, 8, 30, 10, 0, 0, 0, time.UTC)
	resetsAt := time.Date(2026, 9, 30, 0, 0, 0, 0, time.UTC)

	storeA := NewStore(rootA)
	storeB := NewStore(rootB)
	if !storeA.Write(ConfirmedExhaustion(ProviderCodeBuddy, "cbv1:scope-root", observedAt, resetsAt)) {
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
	observedAt := time.Date(2026, 8, 30, 10, 0, 0, 0, time.UTC)
	resetsAt := time.Date(2026, 9, 30, 0, 0, 0, 0, time.UTC)

	for name, record := range map[string]Record{
		"not exhausted": {SchemaVersion: SchemaVersion, Provider: ProviderCodeBuddy, Exhausted: false, Scope: "cbv1:x", ObservedAt: observedAt, ResetsAt: resetsAt, ReasonCode: ReasonQuotaExhausted},
		"empty scope":   {SchemaVersion: SchemaVersion, Provider: ProviderCodeBuddy, Exhausted: true, Scope: "", ObservedAt: observedAt, ResetsAt: resetsAt, ReasonCode: ReasonQuotaExhausted},
		"wrong version": {SchemaVersion: 99, Provider: ProviderCodeBuddy, Exhausted: true, Scope: "cbv1:x", ObservedAt: observedAt, ResetsAt: resetsAt, ReasonCode: ReasonQuotaExhausted},
		"legacy version": {SchemaVersion: 1, Provider: ProviderCodeBuddy, Exhausted: true, Scope: "cbv1:x", ObservedAt: observedAt, ResetsAt: resetsAt, ReasonCode: ReasonMonthlyQuotaExhausted},
		"empty provider": {SchemaVersion: SchemaVersion, Exhausted: true, Scope: "cbv1:x", ObservedAt: observedAt, ResetsAt: resetsAt, ReasonCode: ReasonQuotaExhausted},
		"no reason":      {SchemaVersion: SchemaVersion, Provider: ProviderCodeBuddy, Exhausted: true, Scope: "cbv1:x", ObservedAt: observedAt, ResetsAt: resetsAt},
		"wrong reason":   {SchemaVersion: SchemaVersion, Provider: ProviderCodeBuddy, Exhausted: true, Scope: "cbv1:x", ObservedAt: observedAt, ResetsAt: resetsAt, ReasonCode: "other"},
		"zero observed":  {SchemaVersion: SchemaVersion, Provider: ProviderCodeBuddy, Exhausted: true, Scope: "cbv1:x", ResetsAt: resetsAt, ReasonCode: ReasonQuotaExhausted},
		"zero reset":     {SchemaVersion: SchemaVersion, Provider: ProviderCodeBuddy, Exhausted: true, Scope: "cbv1:x", ObservedAt: observedAt, ReasonCode: ReasonQuotaExhausted},
		"reset not after": {SchemaVersion: SchemaVersion, Provider: ProviderCodeBuddy, Exhausted: true, Scope: "cbv1:x", ObservedAt: observedAt, ResetsAt: observedAt, ReasonCode: ReasonQuotaExhausted},
		"reset before":   {SchemaVersion: SchemaVersion, Provider: ProviderCodeBuddy, Exhausted: true, Scope: "cbv1:x", ObservedAt: observedAt, ResetsAt: observedAt.Add(-time.Hour), ReasonCode: ReasonQuotaExhausted},
		"path traversal": {SchemaVersion: SchemaVersion, Provider: "../escape", Exhausted: true, Scope: "cbv1:x", ObservedAt: observedAt, ResetsAt: resetsAt, ReasonCode: ReasonQuotaExhausted},
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
	observedAt := time.Date(2026, 8, 30, 10, 0, 0, 0, time.UTC)
	resetsAt := time.Date(2026, 9, 30, 0, 0, 0, 0, time.UTC)
	store := NewStore(root)
	if !store.Write(ConfirmedExhaustion(ProviderCodeBuddy, "cbv1:scope-mode", observedAt, resetsAt)) {
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
