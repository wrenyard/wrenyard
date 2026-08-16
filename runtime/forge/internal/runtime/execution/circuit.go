package execution

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/lifecycle/layout"
)

const (
	CircuitStateOpen = "open"

	CircuitReasonStructuredRecovery = "structured_recovery"
	CircuitReasonRetryExhausted     = "retry_exhausted"
	CircuitReasonHardProfileLimit   = "hard_profile_limit"

	circuitSchemaVersion = 1
	circuitLockWait      = 2 * time.Second
	circuitLockInterval  = 10 * time.Millisecond
	circuitStaleAfter    = 30 * time.Second
)

// CircuitRecord is the privacy-safe schema v1 record for one exact profile.
// It intentionally contains no raw profile name, provider, command, prompt,
// credential, native session id, or downstream error.
type CircuitRecord struct {
	SchemaVersion  int          `json:"schema_version"`
	ProfileHash    string       `json:"profile_hash"`
	State          string       `json:"state"`
	OpenedAt       string       `json:"opened_at"`
	UnlockAt       string       `json:"unlock_at"`
	Classification FailureClass `json:"classification"`
	ReasonCode     string       `json:"reason_code"`
	RetryCount     int          `json:"retry_count"`
}

// CircuitCheck is the result of a fail-open circuit lookup. Open is true only
// when a valid record is still in its open interval.
type CircuitCheck struct {
	Record   *CircuitRecord
	Open     bool
	Unlocked bool
	Corrupt  bool
}

// CircuitStore persists one hashed record per exact profile. A store is cheap
// to create and does not retain a process-wide cache, so expiry and corruption
// are handled synchronously on every check.
type CircuitStore struct {
	root  string
	clock Clock
}

// NewCircuitStore creates a per-profile circuit store. A non-empty root is
// used directly; an empty root resolves the production XDG state location.
func NewCircuitStore(root string, clock Clock) *CircuitStore {
	if clock == nil {
		clock = realClock{}
	}
	if strings.TrimSpace(root) == "" {
		root = defaultCircuitRoot()
	}
	return &CircuitStore{root: root, clock: clock}
}

// DefaultCircuitRoot returns the production circuit directory.
func DefaultCircuitRoot() string { return defaultCircuitRoot() }

func defaultCircuitRoot() string {
	return filepath.Join(layout.NewPaths(resolvedHome()).StateDir(), "circuits")
}

// resolvedHome returns the user home directory, honoring HOME/USERPROFILE
// precedence before falling back to the OS home directory.
func resolvedHome() string {
	for _, key := range []string{"HOME", "USERPROFILE"} {
		if home := strings.TrimSpace(os.Getenv(key)); home != "" {
			return home
		}
	}
	home, _ := os.UserHomeDir()
	return home
}

// Path returns the state path for an exact profile id.
func (s *CircuitStore) Path(profile string) string {
	return filepath.Join(s.root, profileHash(profile)+".json")
}

// Check reads one exact-profile record while holding its short-lived lock.
// Corrupt and I/O failures fail open. Corrupt and expired valid records are
// removed while the lock is held; a failed removal still leaves the current
// call closed/open according to the safe result described by the spec.
func (s *CircuitStore) Check(profile string) CircuitCheck {
	if !s.ensureRoot() {
		return CircuitCheck{}
	}
	lock, ok := acquireCircuitLock(filepath.Join(s.root, profileHash(profile)+".lock"))
	if !ok {
		return CircuitCheck{}
	}
	defer lock.release()

	path := s.Path(profile)
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return CircuitCheck{}
		}
		return CircuitCheck{}
	}
	record, err := decodeCircuitRecord(data, profile)
	if err != nil {
		_ = os.Remove(path)
		return CircuitCheck{Corrupt: true}
	}
	unlockAt, _ := parseCircuitTime(record.UnlockAt)
	if !unlockAt.After(s.clock.Now()) {
		_ = os.Remove(path)
		return CircuitCheck{Unlocked: true}
	}
	return CircuitCheck{Record: &record, Open: true}
}

// Write atomically replaces one exact-profile record. It returns whether the
// durable replacement completed; failures leave the old record untouched.
func (s *CircuitStore) Write(profile string, record CircuitRecord) bool {
	if !validCircuitRecord(record, profile) || !s.ensureRoot() {
		return false
	}
	lock, ok := acquireCircuitLock(filepath.Join(s.root, profileHash(profile)+".lock"))
	if !ok {
		return false
	}
	defer lock.release()

	data, err := json.Marshal(record)
	if err != nil {
		return false
	}
	tmpPath := filepath.Join(s.root, profileHash(profile)+".json.tmp."+randomToken())
	f, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return false
	}
	ok = true
	if _, err = f.Write(data); err != nil {
		ok = false
	}
	if ok {
		err = f.Sync()
		if err != nil {
			ok = false
		}
	}
	if closeErr := f.Close(); closeErr != nil {
		ok = false
	}
	if !ok {
		_ = os.Remove(tmpPath)
		return false
	}

	target := s.Path(profile)
	if runtime.GOOS == "windows" {
		// Windows does not guarantee replacement rename semantics. Both readers
		// and writers hold this profile lock, so a protected remove+rename is
		// safe. Restore the old target if the new rename fails.
		backup := target + ".old." + randomToken()
		oldExists := false
		if _, statErr := os.Stat(target); statErr == nil {
			if os.Rename(target, backup) == nil {
				oldExists = true
			} else {
				_ = os.Remove(tmpPath)
				return false
			}
		}
		if err = os.Rename(tmpPath, target); err != nil {
			if oldExists {
				_ = os.Rename(backup, target)
			}
			_ = os.Remove(tmpPath)
			return false
		}
		if oldExists {
			_ = os.Remove(backup)
		}
		return true
	}
	if err = os.Rename(tmpPath, target); err != nil {
		_ = os.Remove(tmpPath)
		return false
	}
	return true
}

func (s *CircuitStore) ensureRoot() bool {
	if err := os.MkdirAll(s.root, 0o700); err != nil {
		return false
	}
	if err := os.Chmod(s.root, 0o700); err != nil {
		return false
	}
	return true
}

func profileHash(profile string) string {
	hash := sha256.Sum256([]byte(profile))
	return hex.EncodeToString(hash[:])
}

func decodeCircuitRecord(data []byte, profile string) (CircuitRecord, error) {
	if len(data) == 0 {
		return CircuitRecord{}, fmt.Errorf("empty circuit record")
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	var record CircuitRecord
	if err := decoder.Decode(&record); err != nil {
		return CircuitRecord{}, fmt.Errorf("invalid circuit record")
	}
	if decoder.More() {
		return CircuitRecord{}, fmt.Errorf("trailing circuit record")
	}
	if err := decoder.Decode(&struct{}{}); err == nil {
		return CircuitRecord{}, fmt.Errorf("trailing circuit record")
	}
	if !validCircuitRecord(record, profile) {
		return CircuitRecord{}, fmt.Errorf("invalid circuit record")
	}
	return record, nil
}

func validCircuitRecord(record CircuitRecord, profile string) bool {
	if record.SchemaVersion != circuitSchemaVersion || record.ProfileHash != profileHash(profile) || record.State != CircuitStateOpen {
		return false
	}
	if record.Classification != FailureClassProfileSpecificLimit && record.Classification != FailureClassTransientProvider {
		return false
	}
	if record.ReasonCode != CircuitReasonStructuredRecovery && record.ReasonCode != CircuitReasonRetryExhausted && record.ReasonCode != CircuitReasonHardProfileLimit {
		return false
	}
	if record.RetryCount < 0 || record.RetryCount > maxProfileRetries {
		return false
	}
	if record.ReasonCode == CircuitReasonRetryExhausted && record.RetryCount != maxProfileRetries {
		return false
	}
	opened, openedOK := parseCircuitTime(record.OpenedAt)
	unlock, unlockOK := parseCircuitTime(record.UnlockAt)
	return openedOK && unlockOK && unlock.After(opened)
}

func parseCircuitTime(raw string) (time.Time, bool) {
	parsed, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return time.Time{}, false
	}
	_, offset := parsed.Zone()
	if offset != 0 {
		return time.Time{}, false
	}
	return parsed.UTC(), true
}

type circuitLock struct {
	path  string
	token string
}

func acquireCircuitLock(path string) (circuitLock, bool) {
	deadline := time.Now().Add(circuitLockWait)
	for {
		token := randomToken()
		f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			content := token + "\n" + strconv.Itoa(os.Getpid()) + "\n" + time.Now().UTC().Format(time.RFC3339) + "\n"
			writeOK := true
			if _, writeErr := f.WriteString(content); writeErr != nil {
				writeOK = false
			}
			if syncErr := f.Sync(); syncErr != nil {
				writeOK = false
			}
			if closeErr := f.Close(); closeErr != nil {
				writeOK = false
			}
			if !writeOK {
				_ = os.Remove(path)
				return circuitLock{}, false
			}
			return circuitLock{path: path, token: token}, true
		}

		if staleCircuitLock(path) {
			reclaim := path + ".reclaim." + randomToken()
			if os.Rename(path, reclaim) == nil {
				_ = os.Remove(reclaim)
				continue
			}
		}
		if time.Now().After(deadline) {
			return circuitLock{}, false
		}
		time.Sleep(circuitLockInterval)
	}
}

func staleCircuitLock(path string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	return time.Since(info.ModTime()) > circuitStaleAfter
}

func (lock circuitLock) release() {
	data, err := os.ReadFile(lock.path)
	if err != nil {
		return
	}
	line := strings.SplitN(string(data), "\n", 2)[0]
	if line != lock.token {
		return
	}
	_ = os.Remove(lock.path)
}

func randomToken() string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err == nil {
		return hex.EncodeToString(raw[:])
	}
	return fmt.Sprintf("%x-%d", os.Getpid(), time.Now().UnixNano())
}
