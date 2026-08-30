// Package observedquota persists a privacy-safe, provider-level observed quota
// exhaustion record. It is the single local state that execution and quota
// projection share: a qualifying CodeBuddy dispatch may record a monthly
// exhaustion here, and the quota command projects it as one canonical provider
// without any network quota query.
//
// The record is deliberately minimal. It never contains raw downstream errors,
// prompts, commands, credentials, profile names, sessions, or auth source.
package observedquota

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// recordSchemaVersion is the version of the on-disk record shape.
const recordSchemaVersion = 1

// SchemaVersion is the version field consumers must stamp when constructing a
// record through the public helpers.
const SchemaVersion = recordSchemaVersion

// ProviderCodeBuddy is the canonical provider id used for the observed
// CodeBuddy quota state. It is the only provider the observation pipeline
// currently records; every local CodeBuddy login state maps to this id.
const ProviderCodeBuddy = "codebuddy"

// ReasonMonthlyQuotaExhausted is the stable reason code for a monthly
// billing-cycle exhaustion. Only the code is persisted; the underlying
// downstream message never is.
const ReasonMonthlyQuotaExhausted = "monthly_quota_exhausted"

// Record is the versioned, privacy-safe provider observation. The fields are
// exactly the observable surface: who, what state, when observed, when it
// resets, and a stable reason code. Nothing else is stored.
type Record struct {
	SchemaVersion int       `json:"schema_version"`
	Provider      string    `json:"provider"`
	Exhausted     bool      `json:"exhausted"`
	ObservedAt    time.Time `json:"observed_at"`
	ResetsAt      time.Time `json:"resets_at"`
	ReasonCode    string    `json:"reason_code"`
}

// MonthlyExhaustion builds a privacy-safe monthly exhaustion record for the
// given provider, observed at now, expiring at resetsAt.
func MonthlyExhaustion(provider string, now, resetsAt time.Time) Record {
	return Record{
		SchemaVersion: recordSchemaVersion,
		Provider:      provider,
		Exhausted:     true,
		ObservedAt:    now.UTC(),
		ResetsAt:      resetsAt.UTC(),
		ReasonCode:    ReasonMonthlyQuotaExhausted,
	}
}

// NextLocalMonthStart returns the first instant of the next local calendar
// month, in UTC. An exhaustion observed at now expires exactly then, matching
// the local billing-cycle boundary. The same instant also unlocks the
// exact-profile hard circuit.
func NextLocalMonthStart(now time.Time) time.Time {
	year, month, _ := now.In(time.Local).Date()
	return time.Date(year, month+1, 1, 0, 0, 0, 0, time.Local).UTC()
}

// Store reads and writes one record per provider under an atomic, mode-0600
// state root. Reads are fail-open and active-only reads stop projecting at
// resets_at.
type Store struct {
	root string
}

// NewStore returns a store rooted at root. An empty root resolves to the
// XDG-aware default state root under the Wrenyard runtime.
func NewStore(root string) *Store {
	return &Store{root: root}
}

// DefaultRoot resolves the XDG-aware default state root under the Wrenyard
// runtime: $XDG_STATE_HOME/wrenyard/runtime, falling back to
// ~/.local/state/wrenyard/runtime when XDG_STATE_HOME is unset.
func DefaultRoot() (string, error) {
	base := strings.TrimSpace(os.Getenv("XDG_STATE_HOME"))
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("observedquota: resolve home directory: %w", err)
		}
		base = filepath.Join(home, ".local", "state")
	}
	return filepath.Join(base, "wrenyard", "runtime"), nil
}

func (s *Store) dir() (string, error) {
	if s.root != "" {
		return s.root, nil
	}
	return DefaultRoot()
}

func (s *Store) path(provider string) (string, error) {
	if provider == "" || strings.ContainsAny(provider, `/\`) {
		return "", fmt.Errorf("observedquota: invalid provider id %q", provider)
	}
	dir, err := s.dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, provider+".json"), nil
}

// Write persists a record atomically with mode 0600. Invalid records are
// rejected and never touch the filesystem.
func (s *Store) Write(record Record) bool {
	if !valid(record) {
		return false
	}
	path, err := s.path(record.Provider)
	if err != nil {
		return false
	}
	data, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return false
	}
	return atomicWrite(path, data)
}

// Read returns the stored record for provider. It fails open: missing files,
// unreadable files, malformed JSON, unknown fields, and records failing strict
// validation all yield ok=false with no error surfaced.
func (s *Store) Read(provider string) (Record, bool) {
	path, err := s.path(provider)
	if err != nil {
		return Record{}, false
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return Record{}, false
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	var record Record
	if err := decoder.Decode(&record); err != nil {
		return Record{}, false
	}
	// Strict decode: reject trailing content after the single record value.
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return Record{}, false
	}
	if !valid(record) || record.Provider != provider {
		return Record{}, false
	}
	return record, true
}

// Active returns the record only when it exists, validates strictly, and its
// resets_at is still strictly in the future at now. Active-only reads therefore
// stop projecting at expiry without any cleanup requirement.
func (s *Store) Active(provider string, now time.Time) (Record, bool) {
	record, ok := s.Read(provider)
	if !ok {
		return Record{}, false
	}
	if !record.ResetsAt.After(now) {
		return Record{}, false
	}
	return record, true
}

func valid(record Record) bool {
	return record.SchemaVersion == recordSchemaVersion &&
		record.Provider != "" &&
		record.Exhausted &&
		!record.ObservedAt.IsZero() &&
		!record.ResetsAt.IsZero() &&
		record.ResetsAt.After(record.ObservedAt) &&
		record.ReasonCode == ReasonMonthlyQuotaExhausted
}

func atomicWrite(path string, data []byte) bool {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return false
	}
	tmp, err := os.CreateTemp(dir, ".observedquota-*.tmp")
	if err != nil {
		return false
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return false
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return false
	}
	if err := tmp.Close(); err != nil {
		return false
	}
	return os.Rename(tmpName, path) == nil
}
