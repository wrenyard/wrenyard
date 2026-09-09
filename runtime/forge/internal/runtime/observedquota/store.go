// Package observedquota persists a privacy-safe, provider-level observed quota
// exhaustion record. It is the single local state that execution and quota
// projection share: a qualifying CodeBuddy dispatch may record a confirmed
// exhaustion here, scoped to the active opaque account scope, and the quota
// command projects it as one canonical provider without any network quota
// query or guessed calendar reset.
//
// Records use schema v2 with an opaque, non-empty Scope and an authoritative,
// caller-supplied ResetsAt. Only an exact-scope v2 record whose resets_at is
// still strictly in the future can ever block. Legacy schema-v1 monthly
// records remain strictly readable for migration, but are inert and are never
// deleted.
//
// The record is deliberately minimal. It never contains raw downstream errors,
// prompts, commands, credentials, profile names, sessions, auth source,
// account/domain material, or tokens.
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

// recordSchemaVersion is the current version of the on-disk record shape.
const recordSchemaVersion = 2

// recordSchemaVersionV1 is the legacy schema-v1 version accepted only by
// strict reads for migration; v1 records never validate as v2.
const recordSchemaVersionV1 = 1

// SchemaVersion is the version field consumers must stamp when constructing a
// record through the public helpers.
const SchemaVersion = recordSchemaVersion

// ProviderCodeBuddy is the canonical provider id used for the observed
// CodeBuddy quota state. It is the only provider the observation pipeline
// currently records; every local CodeBuddy login state maps to this id.
const ProviderCodeBuddy = "codebuddy"

// ReasonQuotaExhausted is the neutral, stable reason code persisted on v2
// scoped records for a confirmed quota exhaustion. Only the code is stored;
// the underlying downstream message never is.
const ReasonQuotaExhausted = "quota_exhausted"

// ReasonMonthlyQuotaExhausted is the schema-v1 monthly reason code, retained
// only so legacy records still decode strictly. v2 records never carry it.
const ReasonMonthlyQuotaExhausted = "monthly_quota_exhausted"

// Record is the versioned, privacy-safe provider observation. The fields are
// exactly the observable surface: who, which opaque scope, what state, when
// observed, the authoritative reset, and a stable reason code. Nothing else is
// stored.
type Record struct {
	SchemaVersion int       `json:"schema_version"`
	Provider      string    `json:"provider"`
	Exhausted     bool      `json:"exhausted"`
	Scope         string    `json:"scope"`
	ObservedAt    time.Time `json:"observed_at"`
	ResetsAt      time.Time `json:"resets_at"`
	ReasonCode    string    `json:"reason_code"`
}

// ConfirmedExhaustion builds a schema-v2 scoped record for a confirmed quota
// exhaustion observed at observedAt and authoritative until the
// caller-supplied resetsAt. The store never infers a reset.
func ConfirmedExhaustion(provider, scope string, observedAt, resetsAt time.Time) Record {
	return Record{
		SchemaVersion: recordSchemaVersion,
		Provider:      provider,
		Exhausted:     true,
		Scope:         scope,
		ObservedAt:    observedAt.UTC(),
		ResetsAt:      resetsAt.UTC(),
		ReasonCode:    ReasonQuotaExhausted,
	}
}

// Store reads and writes one record per provider under an atomic, mode-0600
// state root. Reads are fail-open and active-only reads stop projecting at the
// authoritative resets_at.
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

// Write persists a schema-v2 scoped record atomically with mode 0600. Invalid
// records (including every v1/legacy record) are rejected and never touch the
// filesystem.
func (s *Store) Write(record Record) bool {
	if !validV2(record) {
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
// unreadable files, malformed JSON, unknown fields, and malformed shapes all
// yield ok=false with no error surfaced. Both legacy schema-v1 monthly records
// and schema-v2 scoped records decode strictly; v1 records are returned inert.
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
	if record.Provider != provider {
		return Record{}, false
	}
	if !validV2(record) && !validV1(record) {
		return Record{}, false
	}
	return record, true
}

// ActiveScoped returns the provider record only when it is a schema-v2 scoped
// record whose scope exactly matches currentScope and whose authoritative
// resets_at is still strictly in the future at now. Legacy v1 records are
// readable but never active. Active-only reads therefore stop projecting at
// expiry without any cleanup requirement.
func (s *Store) ActiveScoped(provider, currentScope string, now time.Time) (Record, bool) {
	record, ok := s.Read(provider)
	if !ok {
		return Record{}, false
	}
	if record.SchemaVersion != recordSchemaVersion {
		return Record{}, false
	}
	if record.Scope == "" || record.Scope != currentScope {
		return Record{}, false
	}
	if !record.ResetsAt.After(now) {
		return Record{}, false
	}
	return record, true
}

// validV2 requires the current schema-v2 scoped shape: an opaque non-empty
// scope, a neutral confirmed-exhaustion reason, and consistent authoritative
// timestamps.
func validV2(record Record) bool {
	return record.SchemaVersion == recordSchemaVersion &&
		record.Provider != "" &&
		record.Exhausted &&
		record.Scope != "" &&
		!record.ObservedAt.IsZero() &&
		!record.ResetsAt.IsZero() &&
		record.ResetsAt.After(record.ObservedAt) &&
		record.ReasonCode == ReasonQuotaExhausted
}

// validV1 accepts the legacy schema-v1 monthly shape purely for strict read
// compatibility. Such records are inert: they can never be written or active.
func validV1(record Record) bool {
	return record.SchemaVersion == recordSchemaVersionV1 &&
		record.Provider != "" &&
		record.Exhausted &&
		record.Scope == "" &&
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
