package quota

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type fakeProvider struct {
	name string
	q    Quota
	err  error
}

func (p fakeProvider) Name() string { return p.name }
func (p fakeProvider) Fetch(context.Context) (Quota, error) {
	if p.err != nil {
		return Quota{}, p.err
	}
	return p.q, nil
}

func TestCoerceFloatRejectsNonFiniteValues(t *testing.T) {
	tests := []struct {
		name  string
		value any
	}{
		{name: "float64 NaN", value: math.NaN()},
		{name: "float64 positive infinity", value: math.Inf(1)},
		{name: "float64 negative infinity", value: math.Inf(-1)},
		{name: "float32 NaN", value: float32(math.NaN())},
		{name: "float32 positive infinity", value: float32(math.Inf(1))},
		{name: "float32 negative infinity", value: float32(math.Inf(-1))},
		{name: "json number NaN", value: json.Number("NaN")},
		{name: "json number positive infinity", value: json.Number("+Inf")},
		{name: "json number negative infinity", value: json.Number("-Inf")},
		{name: "string NaN", value: "NaN"},
		{name: "string positive infinity", value: "+Inf"},
		{name: "string negative infinity", value: "-Inf"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got, ok := coerceFloat(tc.value); ok {
				t.Fatalf("coerceFloat(%#v) = %v, true; want rejection", tc.value, got)
			}
		})
	}
}

func TestParseBigModelQuota(t *testing.T) {
	futureMS := time.Now().Add(3 * time.Hour).UnixMilli()
	raw := []byte(`{"data":{"data":{"limits":[
		{"name":"TOKENS_LIMIT","unit":3,"number":5,"used_percent":42,"nextResetTime":` + strconv.FormatInt(futureMS, 10) + `},
		{"name":"TOKENS_LIMIT","unit":6,"number":1,"used":3,"total":10}
	]}}}`)
	q, err := ParseBigModelQuota(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(q.Windows) != 2 || q.Windows[0].Name != "5h" || q.Windows[0].Pct != 42 || q.Windows[1].Name != "7d" || q.Windows[1].Pct != 30 {
		t.Fatalf("windows = %#v", q.Windows)
	}
	if q.Windows[0].ResetsAt == nil {
		t.Fatal("expected ResetsAt for 5h window with nextResetTime")
	}
	if !q.Windows[0].ResetsAt.Equal(time.UnixMilli(futureMS)) {
		t.Fatalf("ResetsAt = %v, want %v", q.Windows[0].ResetsAt, time.UnixMilli(futureMS))
	}
	if q.Windows[1].ResetsAt != nil {
		t.Fatal("expected nil ResetsAt for 7d window without nextResetTime")
	}
}

func TestParseBigModelQuotaNoResetTime(t *testing.T) {
	// Backward compat: nextResetTime is absent, ResetsAt should be nil.
	raw := []byte(`{"data":{"data":{"limits":[
		{"name":"TOKENS_LIMIT","unit":3,"number":5,"used_percent":42}
	]}}}`)
	q, err := ParseBigModelQuota(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(q.Windows) != 1 || q.Windows[0].ResetsAt != nil {
		t.Fatalf("expected nil ResetsAt when nextResetTime absent, got %#v", q.Windows[0].ResetsAt)
	}
}

func TestParseBigModelQuotaResetTimeInPast(t *testing.T) {
	// nextResetTime in the past should be rejected (ResetsAt = nil).
	pastMS := time.Now().Add(-1 * time.Hour).UnixMilli()
	raw := []byte(`{"data":{"data":{"limits":[
		{"name":"TOKENS_LIMIT","unit":3,"number":5,"used_percent":42,"nextResetTime":` + strconv.FormatInt(pastMS, 10) + `}
	]}}}`)
	q, err := ParseBigModelQuota(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(q.Windows) != 1 || q.Windows[0].ResetsAt != nil {
		t.Fatalf("expected nil ResetsAt for past nextResetTime, got %#v", q.Windows[0].ResetsAt)
	}
}

func TestParseBigModelQuotaResetTimeAbsurdlyFarFuture(t *testing.T) {
	// nextResetTime absurdly far in the future (~100 days) should be rejected.
	farMS := time.Now().Add(100 * 24 * time.Hour).UnixMilli()
	raw := []byte(`{"data":{"data":{"limits":[
		{"name":"TOKENS_LIMIT","unit":3,"number":5,"used_percent":42,"nextResetTime":` + strconv.FormatInt(farMS, 10) + `}
	]}}}`)
	q, err := ParseBigModelQuota(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(q.Windows) != 1 || q.Windows[0].ResetsAt != nil {
		t.Fatalf("expected nil ResetsAt for absurdly far future nextResetTime, got %#v", q.Windows[0].ResetsAt)
	}
}

func TestParseBigModelQuotaNewAPIFormat(t *testing.T) {
	raw := []byte(`{"code":200,"data":{"level":"max","limits":[
		{"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":1},
		{"type":"TOKENS_LIMIT","unit":6,"number":1,"percentage":40}
	]},"msg":"ok","success":true}`)
	q, err := ParseBigModelQuota(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(q.Windows) != 2 {
		t.Fatalf("expected 2 windows, got %d: %#v", len(q.Windows), q.Windows)
	}
	if q.Windows[0].Name != "5h" || q.Windows[0].Pct != 1 {
		t.Fatalf("window[0] = %#v, want name=5h pct=1", q.Windows[0])
	}
	if q.Windows[1].Name != "7d" || q.Windows[1].Pct != 40 {
		t.Fatalf("window[1] = %#v, want name=7d pct=40", q.Windows[1])
	}
}

func TestParseBigModelQuotaUnrecognizableResponse(t *testing.T) {
	// Response with limits but no matching TOKENS_LIMIT windows
	raw := []byte(`{"data":{"limits":[{"type":"UNKNOWN_TYPE","percentage":50}]}}`)
	_, err := ParseBigModelQuota(raw)
	if err == nil || !strings.Contains(err.Error(), "windows unavailable") {
		t.Fatalf("expected 'windows unavailable' error, got %v", err)
	}
}

func TestParseBigModelQuotaNonJSON(t *testing.T) {
	raw := []byte(`not json`)
	_, err := ParseBigModelQuota(raw)
	if err == nil {
		t.Fatal("expected error for non-JSON input")
	}
}

func TestBigModelProviderFetchDegradation(t *testing.T) {
	// Unrecognizable JSON response should degrade to "no data" Quota, not error
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":{"limits":[{"type":"UNKNOWN"}]}}`))
	}))
	defer srv.Close()

	p := BigModelProvider{Token: "test-token", URL: srv.URL}
	q, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatalf("expected no error for unrecognizable response, got %v", err)
	}
	if q.Message == "" || !strings.Contains(q.Message, "no data") {
		t.Fatalf("expected 'no data' message in degraded result, got %#v", q)
	}
	if q.Provider != "zhipu-coding" {
		t.Fatalf("expected provider name, got %q", q.Provider)
	}
}

func TestBigModelProviderFetchNonJSON(t *testing.T) {
	// Non-JSON response should also degrade cleanly
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte(`<html>error</html>`))
	}))
	defer srv.Close()

	p := BigModelProvider{Token: "test-token", URL: srv.URL}
	q, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatalf("expected no error for HTML response, got %v", err)
	}
	if q.Message == "" || !strings.Contains(q.Message, "no data") {
		t.Fatalf("expected 'no data' message, got %#v", q)
	}
}

func TestBigModelProviderFetchSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Error("missing or wrong Authorization header")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":{"limits":[
			{"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":12},
			{"type":"TOKENS_LIMIT","unit":6,"number":1,"percentage":65}
		]}}`))
	}))
	defer srv.Close()

	p := BigModelProvider{Token: "test-token", URL: srv.URL}
	q, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(q.Windows) != 2 {
		t.Fatalf("expected 2 windows, got %#v", q.Windows)
	}
	if q.Windows[0].Pct != 12 || q.Windows[1].Pct != 65 {
		t.Fatalf("windows = %#v", q.Windows)
	}
	if q.Message != "" {
		t.Fatalf("expected no message on success, got %q", q.Message)
	}
}

func TestParseKimiQuota(t *testing.T) {
	raw := []byte(`{
		"totalQuota": {
			"limit": "10000",
			"used": "7250",
			"remaining": "2750",
			"resetTime": "2026-02-01T00:00:00Z"
		},
		"usage": {
			"limit": "2048",
			"used": "214",
			"remaining": "1834",
			"resetTime": "2026-01-09T15:23:13.716839300Z"
		},
		"limits": [{
			"window": {"duration": 300, "timeUnit": "TIME_UNIT_MINUTE"},
			"detail": {
				"limit": "200",
				"used": "139",
				"remaining": "61",
				"resetTime": "2026-01-06T13:33:02.717479433Z"
			}
		}]
	}`)
	q, err := ParseKimiQuota(raw)
	if err != nil {
		t.Fatal(err)
	}
	if q.Used == nil || *q.Used != 214 || q.Total == nil || *q.Total != 2048 {
		t.Fatalf("weekly quota = %#v/%#v, want 214/2048", q.Used, q.Total)
	}
	if len(q.Windows) != 3 {
		t.Fatalf("expected 3 windows, got %#v", q.Windows)
	}
	if q.Windows[0].Name != "5h" || q.Windows[0].Pct != 69.5 || q.Windows[0].WindowMinutes != 300 {
		t.Fatalf("5h window = %#v", q.Windows[0])
	}
	if q.Windows[1].Name != "7d" || q.Windows[1].Pct < 10.44 || q.Windows[1].Pct > 10.45 {
		t.Fatalf("weekly window = %#v", q.Windows[1])
	}
	if q.Windows[2].Name != "1mo" || q.Windows[2].Pct != 72.5 || q.Windows[2].WindowMinutes != 43200 {
		t.Fatalf("monthly window = %#v", q.Windows[2])
	}
	if q.Windows[0].ResetsAt == nil || q.Windows[1].ResetsAt == nil || q.Windows[2].ResetsAt == nil {
		t.Fatalf("expected reset times, got %#v", q.Windows)
	}
}

func TestParseKimiQuotaIgnoresEmptyTotalQuota(t *testing.T) {
	raw := []byte(`{
		"totalQuota": {},
		"usage": {"limit": "100", "used": "74", "remaining": "26"},
		"limits": [{
			"window": {"duration": 300, "timeUnit": "TIME_UNIT_MINUTE"},
			"detail": {"limit": "100", "remaining": "100"}
		}]
	}`)

	q, err := ParseKimiQuota(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(q.Windows) != 2 {
		t.Fatalf("empty totalQuota must not fabricate a monthly percentage: %#v", q.Windows)
	}
}

func TestParseClaudeOAuthUsageCurrentSchema(t *testing.T) {
	raw := []byte(`{
		"current_interval_total_count":100,
		"current_interval_usage_count":40,
		"current_interval_remaining_percent":60,
		"current_interval_reset_at":"2026-06-10T10:00:00Z",
		"current_weekly_total_count":200,
		"current_weekly_usage_count":100,
		"current_weekly_window_minutes":10080
	}`)
	q, err := ParseClaudeOAuthUsage(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(q.Windows) != 2 || q.Windows[0].Pct != 40 || q.Windows[1].Pct != 50 {
		t.Fatalf("windows = %#v", q.Windows)
	}
}

func TestParseSnapshotV1(t *testing.T) {
	raw := []byte(`{"primary":{"usedPercent":12,"windowMinutes":300},"secondary":{"usedPercent":34,"windowMinutes":10080}}`)
	q, err := parseSnapshotEntry(raw, "claude")
	if err != nil {
		t.Fatal(err)
	}
	if len(q.Windows) != 2 || q.Windows[0].Name != "5h" || q.Windows[1].Pct != 34 {
		t.Fatalf("windows = %#v", q.Windows)
	}
}

func TestParseSnapshotV2Claude(t *testing.T) {
	raw := []byte(`{
		"enabledProviders":["claude","codex"],
		"entries":[
			{"provider":"codex","primary":{"usedPercent":0,"windowMinutes":300},"secondary":{"usedPercent":96,"windowMinutes":10080}},
			{"provider":"claude","primary":{"usedPercent":25,"windowMinutes":300,"resetsAt":"2026-06-10T18:00:00Z"},"secondary":{"usedPercent":67,"windowMinutes":10080}}
		]
	}`)
	q, err := parseSnapshotEntry(raw, "claude")
	if err != nil {
		t.Fatal(err)
	}
	if len(q.Windows) != 2 || q.Windows[0].Pct != 25 || q.Windows[1].Pct != 67 {
		t.Fatalf("windows = %#v", q.Windows)
	}
	if q.Windows[0].ResetsAt == nil {
		t.Fatal("expected resetsAt for primary window")
	}
}

func TestParseSnapshotV2Codex(t *testing.T) {
	raw := []byte(`{
		"enabledProviders":["claude","codex"],
		"entries":[
			{"provider":"codex","primary":{"usedPercent":0,"windowMinutes":300},"secondary":{"usedPercent":96,"windowMinutes":10080,"resetsAt":"2026-06-14T12:00:00Z"}},
			{"provider":"claude","primary":{"usedPercent":25,"windowMinutes":300},"secondary":{"usedPercent":67,"windowMinutes":10080}}
		]
	}`)
	q, err := parseSnapshotEntry(raw, "codex")
	if err != nil {
		t.Fatal(err)
	}
	if len(q.Windows) != 2 || q.Windows[0].Pct != 0 || q.Windows[1].Pct != 96 {
		t.Fatalf("windows = %#v", q.Windows)
	}
	if q.Windows[1].ResetsAt == nil {
		t.Fatal("expected resetsAt for secondary codex window")
	}
}

func TestParseSnapshotV2ProviderNotFound(t *testing.T) {
	raw := []byte(`{"enabledProviders":["codex"],"entries":[{"provider":"codex","primary":{"usedPercent":10,"windowMinutes":300}}]}`)
	_, err := parseSnapshotEntry(raw, "claude")
	if err == nil || !strings.Contains(err.Error(), "provider not found") {
		t.Fatalf("expected 'provider not found', got %v", err)
	}
}

func TestParseSnapshotV1NonClaudeFails(t *testing.T) {
	raw := []byte(`{"primary":{"usedPercent":12,"windowMinutes":300},"secondary":{"usedPercent":34,"windowMinutes":10080}}`)
	_, err := parseSnapshotEntry(raw, "codex")
	if err == nil || !strings.Contains(err.Error(), "format unsupported") {
		t.Fatalf("expected 'format unsupported', got %v", err)
	}
}

func TestWindowName(t *testing.T) {
	cases := []struct {
		minutes int
		want    string
	}{
		{300, "5h"},
		{10080, "7d"},
		{60, "1h"},
		{1440, "1d"},
		{45, "45m"},
		{2880, "2d"},
		{720, "12h"},
	}
	for _, tc := range cases {
		t.Run(tc.want, func(t *testing.T) {
			if got := windowName(tc.minutes); got != tc.want {
				t.Fatalf("windowName(%d) = %q, want %q", tc.minutes, got, tc.want)
			}
		})
	}
}

func TestCachedProviderTTLAndStale(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")
	fresh := Quota{Provider: "fake", Used: Float64(1), Total: Float64(2), FetchedAt: timeNow()}
	p := CachedProvider{Inner: fakeProvider{name: "fake", q: fresh}, Path: path, TTL: time.Hour}
	if _, err := p.Fetch(context.Background()); err != nil {
		t.Fatal(err)
	}
	p.Inner = fakeProvider{name: "fake", err: errors.New("offline")}
	q, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if q.Stale {
		t.Fatalf("fresh cache should not be stale")
	}

	old := Quota{Provider: "fake", Used: Float64(3), Total: Float64(4), FetchedAt: timeNow().Add(-2 * time.Hour)}
	if err := writeCache(path, old); err != nil {
		t.Fatal(err)
	}
	p.TTL = time.Second
	q, err = p.Fetch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !q.Stale || q.Used == nil || *q.Used != 3 {
		t.Fatalf("stale cache not served: %#v", q)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
}

func TestWriteCacheAtomicRenameKeepsReadableState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")
	old := Quota{Provider: "fake", Used: Float64(1), Total: Float64(2), FetchedAt: timeNow()}
	if err := writeCache(path, old); err != nil {
		t.Fatal(err)
	}
	// Create a stale .tmp file (old pattern) — shouldn't affect atomic write.
	if err := os.WriteFile(path+".tmp", []byte(`{"quota":`), 0o600); err != nil {
		t.Fatal(err)
	}
	q, ok := ReadCache(path)
	if !ok || q.Used == nil || *q.Used != 1 {
		t.Fatalf("stale tmp write changed readable cache: %#v, %v", q, ok)
	}

	next := Quota{Provider: "fake", Used: Float64(3), Total: Float64(4), FetchedAt: timeNow()}
	if err := writeCache(path, next); err != nil {
		t.Fatal(err)
	}
	q, ok = ReadCache(path)
	if !ok || q.Used == nil || *q.Used != 3 {
		t.Fatalf("renamed cache not readable: %#v, %v", q, ok)
	}
}

// inlineRefreshSpawner performs the refresh synchronously in-process.
// Used by SWR tests that previously relied on a goroutine (now subprocess).
type inlineRefreshSpawner struct {
	inner Provider
}

func (s *inlineRefreshSpawner) Spawn(providerName, cachePath, lockToken string) error {
	// Re-read the lockfile so we can release it after work (simulates
	// what the detached subprocess does).
	lockPath := cachePath + ".refresh.lock"

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	q, err := s.inner.Fetch(ctx)
	if err != nil {
		// Release the lock even on failure (same as subprocess).
		releaseLockTokenInline(lockPath, lockToken)
		return err
	}
	if q.FetchedAt.IsZero() {
		q.FetchedAt = time.Now()
	}
	_ = WriteCache(cachePath, q)

	// Release the lockfile (only if token matches — same as subprocess).
	releaseLockTokenInline(lockPath, lockToken)
	return nil
}

// releaseLockTokenInline removes the lockfile if the stored token matches.
func releaseLockTokenInline(lockPath, token string) {
	data, err := os.ReadFile(lockPath)
	if err != nil {
		_ = os.Remove(lockPath)
		return
	}
	if strings.TrimSpace(string(data)) == token {
		_ = os.Remove(lockPath)
	}
}

// countingProvider counts Fetch calls for SWR and dedup tests.
type countingProvider struct {
	name  string
	q     Quota
	err   error
	count *int32
}

func (p *countingProvider) Name() string { return p.name }
func (p *countingProvider) Fetch(ctx context.Context) (Quota, error) {
	if p.count != nil {
		atomic.AddInt32(p.count, 1)
	}
	if p.err != nil {
		return Quota{}, p.err
	}
	return p.q, nil
}

func TestSWRReturnsStaleAndTriggersOneRefresh(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")
	var fetchCount int32

	// Seed cache with data 3 minutes old.
	old := Quota{Provider: "test", Used: Float64(1), Total: Float64(10), FetchedAt: timeNow().Add(-3 * time.Minute)}
	if err := writeCache(path, old); err != nil {
		t.Fatal(err)
	}

	inner := &countingProvider{
		name:  "test",
		q:     Quota{Provider: "test", Used: Float64(2), Total: Float64(10), FetchedAt: timeNow()},
		count: &fetchCount,
	}

	// TTL = 10min, RefreshAge = 2min → cache is 3min old, should trigger SWR.
	p := &CachedProvider{
		Inner:      inner,
		Path:       path,
		TTL:        10 * time.Minute,
		RefreshAge: 2 * time.Minute,
		Spawner:    &inlineRefreshSpawner{inner: inner},
	}

	q, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// Should return stale data immediately.
	if q.Used == nil || *q.Used != 1 {
		t.Fatalf("expected stale used=1, got %#v", q.Used)
	}

	// The inlineSpawner runs synchronously — no need to Sleep.
	// Exactly one background refresh should have been triggered.
	if n := atomic.LoadInt32(&fetchCount); n != 1 {
		t.Fatalf("expected exactly 1 background refresh, got %d", n)
	}

	// Next fetch should get the refreshed data from cache.
	q2, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if q2.Used == nil || *q2.Used != 2 {
		t.Fatalf("expected refreshed used=2, got %#v", q2.Used)
	}
	// No additional fetch should have happened (cache is fresh).
	if n := atomic.LoadInt32(&fetchCount); n != 1 {
		t.Fatalf("expected still 1 fetch after fresh cache hit, got %d", n)
	}
}

func TestSWRSingleFlightDedup(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")
	var fetchCount int32

	// Seed old cache that triggers SWR.
	old := Quota{Provider: "test", Used: Float64(1), Total: Float64(10), FetchedAt: timeNow().Add(-3 * time.Minute)}
	if err := writeCache(path, old); err != nil {
		t.Fatal(err)
	}

	inner := &countingProvider{
		name:  "test",
		q:     Quota{Provider: "test", Used: Float64(2), Total: Float64(10), FetchedAt: timeNow()},
		count: &fetchCount,
	}

	p := &CachedProvider{
		Inner:      inner,
		Path:       path,
		TTL:        10 * time.Minute,
		RefreshAge: 2 * time.Minute,
		Spawner:    &inlineRefreshSpawner{inner: inner},
	}

	// Call Fetch multiple times concurrently — SWR should dedupe.
	done := make(chan bool, 5)
	for i := 0; i < 5; i++ {
		go func() {
			_, _ = p.Fetch(context.Background())
			done <- true
		}()
	}
	for i := 0; i < 5; i++ {
		<-done
	}

	// Inline spawner runs synchronously — no need to Sleep.
	// Single-flight via lockfile (O_EXCL) ensures exactly 1 refresh.
	if n := atomic.LoadInt32(&fetchCount); n != 1 {
		t.Fatalf("expected exactly 1 background refresh (single-flight), got %d", n)
	}
}

func TestSWRRefreshAgeZeroDisablesSWR(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")
	var fetchCount int32

	// Seed cache 3min old.
	old := Quota{Provider: "test", Used: Float64(1), Total: Float64(10), FetchedAt: timeNow().Add(-3 * time.Minute)}
	if err := writeCache(path, old); err != nil {
		t.Fatal(err)
	}

	inner := &countingProvider{
		name:  "test",
		q:     Quota{Provider: "test", Used: Float64(2), Total: Float64(10), FetchedAt: timeNow()},
		count: &fetchCount,
	}

	// RefreshAge=0 means no SWR (backward compat) — should not trigger background refresh.
	// Use NoopSpawner so we can verify it was never called.
	noop := &NoopSpawner{}
	p := &CachedProvider{Inner: inner, Path: path, TTL: 10 * time.Minute, Spawner: noop}

	q, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// Returns cached data (within TTL).
	if q.Used == nil || *q.Used != 1 {
		t.Fatalf("expected stale used=1, got %#v", q.Used)
	}

	// No background refresh should have been triggered since RefreshAge=0.
	if n := atomic.LoadInt32(&fetchCount); n != 0 {
		t.Fatalf("expected 0 fetches when RefreshAge=0, got %d", n)
	}
	// Spawner must not have been called.
	if noop.Calls != 0 {
		t.Fatalf("expected 0 spawn calls when RefreshAge=0, got %d", noop.Calls)
	}
}

func TestSWRNegativeCacheUnchanged(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")
	var fetchCount int32

	inner := &countingProvider{
		name:  "test",
		err:   errors.New("simulated failure"),
		count: &fetchCount,
	}

	// Short TTL so failure marker works quickly.
	p := &CachedProvider{Inner: inner, Path: path, TTL: 1 * time.Second, RefreshAge: 500 * time.Millisecond, Spawner: &NoopSpawner{}}

	// First fetch: fails and writes failure marker.
	_, err := p.Fetch(context.Background())
	if err == nil {
		t.Fatal("expected error")
	}
	if n := atomic.LoadInt32(&fetchCount); n != 1 {
		t.Fatalf("expected 1 fetch, got %d", n)
	}

	// Second fetch: should return error from failure marker without calling Inner.
	_, err = p.Fetch(context.Background())
	if err == nil {
		t.Fatal("expected error")
	}
	if n := atomic.LoadInt32(&fetchCount); n != 1 {
		t.Fatalf("failure marker should block refetch, got %d fetches", n)
	}
}

func TestReadCacheRejectsPureFailureMarker(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")

	// Write a pure failure marker (no quota data, just FailedAt).
	now := time.Now()
	if err := writeFailureMarker(path, now, "test error"); err != nil {
		t.Fatal(err)
	}

	// ReadCache should return false — no valid cached data.
	_, ok := ReadCache(path)
	if ok {
		t.Fatal("ReadCache should return false for pure failure marker (no quota data)")
	}

	// But Fetch should still return the error (negative cache).
	var fetchCount int32
	inner := &countingProvider{
		name:  "test",
		err:   errors.New("still failing"),
		count: &fetchCount,
	}
	p := &CachedProvider{Inner: inner, Path: path, TTL: 10 * time.Minute, Spawner: &NoopSpawner{}}
	_, err := p.Fetch(context.Background())
	if err == nil {
		t.Fatal("Fetch should return error from negative cache")
	}
	if n := atomic.LoadInt32(&fetchCount); n != 0 {
		t.Fatalf("negative cache should prevent fetch, got %d", n)
	}
}

// --- Detached subprocess spawn tests ---

func TestKickBackgroundRefreshSpawnsViaInjectedSpawner(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")
	var fetchCount int32

	old := Quota{Provider: "test", Used: Float64(1), Total: Float64(10), FetchedAt: timeNow().Add(-3 * time.Minute)}
	if err := writeCache(path, old); err != nil {
		t.Fatal(err)
	}

	inner := &countingProvider{
		name:  "test",
		q:     Quota{Provider: "test", Used: Float64(2), Total: Float64(10), FetchedAt: timeNow()},
		count: &fetchCount,
	}

	noop := &NoopSpawner{}
	p := &CachedProvider{
		Inner:      inner,
		Path:       path,
		TTL:        10 * time.Minute,
		RefreshAge: 2 * time.Minute,
		Spawner:    noop,
	}

	q, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if q.Used == nil || *q.Used != 1 {
		t.Fatalf("expected stale used=1, got %#v", q.Used)
	}

	// Spawn decision: should have attempted to spawn exactly once.
	if noop.Calls != 1 {
		t.Fatalf("expected exactly 1 spawn call, got %d", noop.Calls)
	}
	if noop.LastName != "test" {
		t.Fatalf("expected provider name 'test', got %q", noop.LastName)
	}
	if noop.LastPath != path {
		t.Fatalf("expected path %q, got %q", path, noop.LastPath)
	}
	if noop.LastToken == "" {
		t.Fatal("expected non-empty lock token")
	}

	// Verify the lockfile was created (parent held it until spawn).
	lockPath := path + ".refresh.lock"
	fi, err := os.Stat(lockPath)
	if err != nil || fi == nil {
		t.Fatal("lockfile should exist after spawn (NoopSpawner doesn't release)")
	}
}

func TestKickBackgroundRefreshSingleFlightViaLockfile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")
	var fetchCount int32

	old := Quota{Provider: "test", Used: Float64(1), Total: Float64(10), FetchedAt: timeNow().Add(-3 * time.Minute)}
	if err := writeCache(path, old); err != nil {
		t.Fatal(err)
	}

	inner := &countingProvider{
		name:  "test",
		q:     Quota{Provider: "test", Used: Float64(2), Total: Float64(10), FetchedAt: timeNow()},
		count: &fetchCount,
	}

	// Use a held spawner so the first triggered refresh keeps the lock.
	// The NoopSpawner doesn't remove the lockfile, so concurrent
	// AcquireRefreshLock calls will see it and skip.
	released := make(chan struct{})
	heldSpawner := &NoopSpawner{Hold: true, Released: released}

	p := &CachedProvider{
		Inner:      inner,
		Path:       path,
		TTL:        10 * time.Minute,
		RefreshAge: 2 * time.Minute,
		Spawner:    heldSpawner,
	}

	// Call Fetch from multiple goroutines concurrently.
	// One will trigger SWR and block in the held spawner.
	// Others will skip because the lockfile exists.
	done := make(chan bool, 5)
	for i := 0; i < 5; i++ {
		go func() {
			_, _ = p.Fetch(context.Background())
			done <- true
		}()
	}

	// Wait for the 4 goroutines that skip SWR to finish.
	// The 5th is stuck in the held spawner — won't complete yet.
	// Note: the throttle stamp now happens under the lock after
	// acquisition, so we must wait for ALL goroutines before
	// asserting the spawn count.
	for i := 0; i < 4; i++ {
		<-done
	}

	// Release the held spawner so the last goroutine finishes.
	close(released)
	<-done // 5th goroutine

	// Only one spawn should have happened (the lockfile blocks the others).
	if heldSpawner.Calls != 1 {
		t.Fatalf("expected exactly 1 spawn (lockfile single-flight), got %d", heldSpawner.Calls)
	}
}

type failSpawner struct {
	called bool
}

func (f *failSpawner) Spawn(_, _, _ string) error {
	f.called = true
	return errors.New("spawn failed")
}

func TestKickBackgroundRefreshReleasesLockOnSpawnFailure(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")
	lockPath := path + ".refresh.lock"

	old := Quota{Provider: "test", Used: Float64(1), Total: Float64(10), FetchedAt: timeNow().Add(-3 * time.Minute)}
	if err := writeCache(path, old); err != nil {
		t.Fatal(err)
	}

	fs := &failSpawner{}
	p := &CachedProvider{
		Inner:      fakeProvider{name: "test", q: Quota{Provider: "test", Used: Float64(2), Total: Float64(10), FetchedAt: timeNow()}},
		Path:       path,
		TTL:        10 * time.Minute,
		RefreshAge: 2 * time.Minute,
		Spawner:    fs,
	}

	// Fetch triggers SWR → kickBackgroundRefresh → failSpawner.
	_, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	if !fs.called {
		t.Fatal("expected failSpawner to be called")
	}

	// The lockfile must be released after spawn failure.
	if _, err := os.Stat(lockPath); err == nil {
		t.Fatal("lockfile must be released after spawn failure, but it still exists")
	}

	// A second Fetch should be able to re-acquire and attempt another
	// spawn — but the throttle (LastAttemptAt) blocks retries within
	// the refresh window. Clear LastAttemptAt from the cache to simulate
	// the throttle window expiring, then verify retry succeeds.
	entry, ok := readCache(path)
	if !ok {
		t.Fatal("cache should exist")
	}
	entry.LastAttemptAt = time.Time{}
	if err := writeCacheEntryRaw(path, entry); err != nil {
		t.Fatal(err)
	}

	fs.called = false
	_, err = p.Fetch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !fs.called {
		t.Fatal("expected second spawn call after lock was freed by first failure")
	}
}

func TestRefreshLockAcquireExclusive(t *testing.T) {
	lockPath := filepath.Join(t.TempDir(), "test.lock")

	l1, err := AcquireRefreshLock(lockPath)
	if err != nil {
		t.Fatal(err)
	}

	// Second acquisition must fail while lock is held.
	_, err = AcquireRefreshLock(lockPath)
	if err == nil {
		t.Fatal("expected error when acquiring already-held lock")
	}

	// Release and re-acquire.
	l1.Release()
	l2, err := AcquireRefreshLock(lockPath)
	if err != nil {
		t.Fatal(err)
	}
	if l2.Token == "" {
		t.Fatal("expected non-empty token")
	}
	l2.Release()

	// Lockfile should be gone.
	if _, err := os.Stat(lockPath); err == nil {
		t.Fatal("lockfile should be removed after Release")
	}
}

func TestRefreshLockStaleReclaim(t *testing.T) {
	lockPath := filepath.Join(t.TempDir(), "test.lock")

	// Set a very short stale timeout for testing.
	SetRefreshLockStaleTimeout(50 * time.Millisecond)
	defer SetRefreshLockStaleTimeout(2 * time.Minute)

	l1, err := AcquireRefreshLock(lockPath)
	if err != nil {
		t.Fatal(err)
	}
	token1 := l1.Token

	// Don't release — simulate a dead subprocess.
	_ = l1 // keep alive to avoid GC freeing the struct

	// Wait for lock to become stale.
	time.Sleep(100 * time.Millisecond)

	// Another process should be able to reclaim.
	l2, err := AcquireRefreshLock(lockPath)
	if err != nil {
		t.Fatal(err)
	}
	if l2.Token == token1 {
		t.Fatal("reclaimed lock should have a new token")
	}
	l2.Release()
}

func TestRefreshLockStaleReclaimRace(t *testing.T) {
	lockPath := filepath.Join(t.TempDir(), "test.lock")

	// Create a stale lockfile that both reclaimers will see.
	SetRefreshLockStaleTimeout(50 * time.Millisecond)
	defer SetRefreshLockStaleTimeout(2 * time.Minute)

	l1, err := AcquireRefreshLock(lockPath)
	if err != nil {
		t.Fatal(err)
	}
	token1 := l1.Token
	l1.Release()

	// Re-write the same token but backdate mtime so it's stale.
	// We need a lockfile that exists and is older than staleTimeout.
	if err := os.WriteFile(lockPath, []byte(token1+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	past := time.Now().Add(-10 * time.Minute)
	if err := os.Chtimes(lockPath, past, past); err != nil {
		t.Fatal(err)
	}

	// Two concurrent reclaimers — at most one may succeed.
	const N = 2
	type result struct {
		lock *RefreshLock
		err  error
	}
	ch := make(chan result, N)
	for i := 0; i < N; i++ {
		go func() {
			l, err := AcquireRefreshLock(lockPath)
			ch <- result{lock: l, err: err}
		}()
	}

	var winners int
	var losers int
	var acquired []*RefreshLock
	for i := 0; i < N; i++ {
		r := <-ch
		if r.err != nil {
			losers++
		} else {
			winners++
			acquired = append(acquired, r.lock)
		}
	}
	for _, lock := range acquired {
		lock.Release()
	}

	if winners != 1 {
		t.Fatalf("expected exactly 1 reclaim winner, got %d (losers=%d)", winners, losers)
	}
	if losers != 1 {
		t.Fatalf("expected exactly 1 reclaim loser, got %d", losers)
	}

	// The lockfile should have been removed by the winner's Release()
	// or contain a fresh token. Since both reclaimers have finished,
	// the lock should not be left behind.
	if _, err := os.Stat(lockPath); err == nil {
		// Might exist if the winner hasn't released yet — read and verify.
		data, _ := os.ReadFile(lockPath)
		t.Fatalf("lockfile should have been released; leftover content: %q", strings.TrimSpace(string(data)))
	}
}

func TestSafeAtomicWriteRenameFailureCleansUpTemp(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "test.json")

	// Make target a directory so os.Rename(tmpName, target) fails
	// (cannot rename a regular file over a directory on Unix).
	if err := os.MkdirAll(target, 0o700); err != nil {
		t.Fatal(err)
	}

	err := SafeAtomicWrite(target, []byte("data"), 0o600)
	if err == nil {
		t.Skip("rename over directory succeeded on this platform — cannot verify cleanup")
	}

	// Verify no .tmp files remain after failed atomic write.
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			data, _ := os.ReadFile(filepath.Join(dir, e.Name()))
			t.Fatalf("temp file %s was not cleaned up after rename failure; content: %q", e.Name(), string(data))
		}
	}
}

func TestRefreshLockCheckOwnership(t *testing.T) {
	lockPath := filepath.Join(t.TempDir(), "test.lock")

	l, err := AcquireRefreshLock(lockPath)
	if err != nil {
		t.Fatal(err)
	}

	if !l.CheckOwnership() {
		t.Fatal("should own the lock after acquisition")
	}

	// Overwrite with a different token.
	if err := os.WriteFile(lockPath, []byte("different-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if l.CheckOwnership() {
		t.Fatal("should not own the lock after token changed")
	}

	// Release must not remove a different owner's lockfile.
	l.Release()
	if _, err := os.Stat(lockPath); err != nil {
		t.Fatal("lockfile should still exist (token mismatch)")
	}
}

func TestInlineRefreshSpawnerUpdatesCache(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")

	// Seed old cache.
	old := Quota{Provider: "test", Used: Float64(1), Total: Float64(10), FetchedAt: timeNow().Add(-3 * time.Minute)}
	if err := writeCache(path, old); err != nil {
		t.Fatal(err)
	}

	var fetchCount int32
	inner := &countingProvider{
		name:  "test",
		q:     Quota{Provider: "test", Used: Float64(2), Total: Float64(10), FetchedAt: timeNow()},
		count: &fetchCount,
	}

	p := &CachedProvider{
		Inner:      inner,
		Path:       path,
		TTL:        10 * time.Minute,
		RefreshAge: 2 * time.Minute,
		Spawner:    &inlineRefreshSpawner{inner: inner},
	}

	q, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// Should return stale data.
	if q.Used == nil || *q.Used != 1 {
		t.Fatalf("expected stale used=1, got %#v", q.Used)
	}

	// The inlineSpawner fetches synchronously — check cache was updated.
	if n := atomic.LoadInt32(&fetchCount); n != 1 {
		t.Fatalf("expected 1 fetch from inline spawner, got %d", n)
	}

	// Re-read cache — should have the refreshed data.
	q2, ok := ReadCache(path)
	if !ok {
		t.Fatal("cache should be readable after inline refresh")
	}
	if q2.Used == nil || *q2.Used != 2 {
		t.Fatalf("expected refreshed used=2, got %#v", q2.Used)
	}

	// --- SWR-only mode tests ---
}

// fetchIsFatal provides a Provider whose Fetch calls t.Fatal — used to
// verify that SWROnly mode never calls Inner.Fetch.
type fetchIsFatal struct {
	t *testing.T
}

func (p fetchIsFatal) Name() string { return "fatal" }
func (p fetchIsFatal) Fetch(ctx context.Context) (Quota, error) {
	p.t.Fatal("Inner.Fetch must not be called in SWR-only mode")
	return Quota{}, nil
}

func TestSWROnlyRenderPathReturnsCachedNeverCallsInner(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")

	// Seed a valid cache.
	now := time.Now()
	entry := cacheEntry{
		Quota:     Quota{Provider: "test", Used: Float64(100), Total: Float64(7000)},
		FetchedAt: now,
	}
	if err := writeCacheEntryRaw(path, entry); err != nil {
		t.Fatal(err)
	}

	// SWR-only with a fatal inner — must not call Inner.Fetch.
	p := &CachedProvider{
		Inner:      fetchIsFatal{t: t},
		Path:       path,
		TTL:        120 * time.Second,
		RefreshAge: 30 * time.Second,
		SWROnly:    true,
		Spawner:    &NoopSpawner{},
	}

	q, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if q.Used == nil || *q.Used != 100 {
		t.Fatalf("expected used=100, got %#v", q.Used)
	}
}

func TestSWROnlyCacheAbsentReturnsEmptyNoFetch(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")
	// No cache file exists.

	noop := &NoopSpawner{}
	p := &CachedProvider{
		Inner:      fetchIsFatal{t: t},
		Path:       path,
		TTL:        120 * time.Second,
		RefreshAge: 30 * time.Second,
		SWROnly:    true,
		Spawner:    noop,
	}

	q, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Should return empty/zero Quota.
	if q.Used != nil || q.Total != nil {
		t.Fatalf("expected empty quota, got %#v", q)
	}
	// Should have kicked the spawn.
	if noop.Calls != 1 {
		t.Fatalf("expected 1 spawn call, got %d", noop.Calls)
	}
}

func TestSWROnlyCacheHardExpiredReturnsStaleKicksSpawn(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")

	// Write a cache that is 5 minutes old with TTL of 2 minutes.
	oldTime := time.Now().Add(-5 * time.Minute)
	entry := cacheEntry{
		Quota:     Quota{Provider: "test", Used: Float64(200), Total: Float64(7000)},
		FetchedAt: oldTime,
	}
	if err := writeCacheEntryRaw(path, entry); err != nil {
		t.Fatal(err)
	}

	noop := &NoopSpawner{}
	p := &CachedProvider{
		Inner:      fetchIsFatal{t: t},
		Path:       path,
		TTL:        120 * time.Second,
		RefreshAge: 30 * time.Second,
		SWROnly:    true,
		Spawner:    noop,
	}

	q, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Must return cached data, marked stale.
	if q.Used == nil || *q.Used != 200 {
		t.Fatalf("expected used=200, got %#v", q.Used)
	}
	if !q.Stale {
		t.Fatal("hard-expired cache must be marked stale")
	}
	// Must have kicked the background spawn.
	if noop.Calls != 1 {
		t.Fatalf("expected 1 spawn call, got %d", noop.Calls)
	}
}

// writeCacheEntryRaw writes a full cacheEntry (including CooldownUntil) to disk.
// Used by SWR-only tests that need to seed cooldown state.
func writeCacheEntryRaw(path string, entry cacheEntry) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(entry, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, raw, 0o600)
}

func TestSWROnlyActiveCooldownNoFetchNoSpawn(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")

	// Write a cache that is past TTL with an active cooldown.
	oldTime := time.Now().Add(-3 * time.Minute)
	entry := cacheEntry{
		Quota:         Quota{Provider: "test", Used: Float64(300), Total: Float64(7000)},
		FetchedAt:     oldTime,
		CooldownUntil: time.Now().Add(5 * time.Minute), // active cooldown
	}
	if err := writeCacheEntryRaw(path, entry); err != nil {
		t.Fatal(err)
	}

	noop := &NoopSpawner{}
	p := &CachedProvider{
		Inner:      fetchIsFatal{t: t},
		Path:       path,
		TTL:        120 * time.Second, // cache is past TTL
		RefreshAge: 30 * time.Second,
		SWROnly:    true,
		Spawner:    noop,
	}

	q, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Must return cached data (stale).
	if q.Used == nil || *q.Used != 300 {
		t.Fatalf("expected used=300, got %#v", q.Used)
	}
	if !q.Stale {
		t.Fatal("expected stale=true with active cooldown")
	}
	// Active cooldown: no spawn, no Inner fetch.
	if noop.Calls != 0 {
		t.Fatalf("expected 0 spawn calls with active cooldown, got %d", noop.Calls)
	}
}

func TestSWROnlyCooldownExpiredKicksSpawnNoSyncFetch(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")

	// Write a cache that is past TTL with an expired cooldown.
	oldTime := time.Now().Add(-3 * time.Minute)
	entry := cacheEntry{
		Quota:         Quota{Provider: "test", Used: Float64(400), Total: Float64(7000)},
		FetchedAt:     oldTime,
		CooldownUntil: time.Now().Add(-1 * time.Minute), // expired
	}
	if err := writeCacheEntryRaw(path, entry); err != nil {
		t.Fatal(err)
	}

	noop := &NoopSpawner{}
	p := &CachedProvider{
		Inner:      fetchIsFatal{t: t},
		Path:       path,
		TTL:        120 * time.Second, // cache is past TTL
		RefreshAge: 30 * time.Second,
		SWROnly:    true,
		Spawner:    noop,
	}

	q, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Must return cached data (stale).
	if q.Used == nil || *q.Used != 400 {
		t.Fatalf("expected used=400, got %#v", q.Used)
	}
	if !q.Stale {
		t.Fatal("expected stale=true with hard-expired cache")
	}
	// Cooldown expired on stale cache: spawn must be kicked.
	if noop.Calls != 1 {
		t.Fatalf("expected 1 spawn call after cooldown expired, got %d", noop.Calls)
	}
}

func TestSWROnlyActiveCooldownReturnsUnavailable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")

	// Write a cache with an active cooldown.
	oldTime := time.Now().Add(-3 * time.Minute)
	entry := cacheEntry{
		Quota:         Quota{Provider: "test", Used: Float64(300), Total: Float64(7000)},
		FetchedAt:     oldTime,
		CooldownUntil: time.Now().Add(5 * time.Minute), // active
	}
	if err := writeCacheEntryRaw(path, entry); err != nil {
		t.Fatal(err)
	}

	p := &CachedProvider{
		Inner:      fetchIsFatal{t: t},
		Path:       path,
		TTL:        120 * time.Second,
		RefreshAge: 30 * time.Second,
		SWROnly:    true,
		Spawner:    &NoopSpawner{},
	}

	q, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !q.Unavailable {
		t.Fatal("expected Unavailable=true when cooldown is active")
	}
	if !q.Stale {
		t.Fatal("expected Stale=true with active cooldown")
	}
}

func TestReadCacheReturnsUnavailableFromCooldown(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")

	entry := cacheEntry{
		Quota:         Quota{Provider: "test", Used: Float64(100), Total: Float64(7000)},
		FetchedAt:     time.Now(),
		CooldownUntil: time.Now().Add(5 * time.Minute), // active
	}
	if err := writeCacheEntryRaw(path, entry); err != nil {
		t.Fatal(err)
	}

	q, ok := ReadCache(path)
	if !ok {
		t.Fatal("expected cache to be readable")
	}
	if !q.Unavailable {
		t.Fatal("expected Unavailable=true from cooldown entry")
	}
}

func TestReadCacheNoUnavailableWithoutCooldown(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")

	entry := cacheEntry{
		Quota:     Quota{Provider: "test", Used: Float64(100), Total: Float64(7000)},
		FetchedAt: timeNow().Add(-3 * time.Minute), // stale-aged but healthy
	}
	if err := writeCacheEntryRaw(path, entry); err != nil {
		t.Fatal(err)
	}

	q, ok := ReadCache(path)
	if !ok {
		t.Fatal("expected cache to be readable")
	}
	if q.Unavailable {
		t.Fatal("expected Unavailable=false without active cooldown")
	}
}

// --- LastAttemptAt throttle tests ---

// TestKickBackgroundRefreshThrottledByLastAttemptAt verifies that
// kickBackgroundRefresh skips spawning when LastAttemptAt is within
// the RefreshAge window, even when FetchedAt is stale and no cooldown
// is active. This prevents spawn-storms on fast non-cookie failures.
func TestKickBackgroundRefreshThrottledByLastAttemptAt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")

	// Seed a cache that is stale (3 min old, refreshAge=90s) with a
	// recent last_attempt_at (30 seconds ago — within the 90s window).
	old := time.Now().Add(-3 * time.Minute)
	entry := cacheEntry{
		Quota:         Quota{Provider: "test", Used: Float64(1), Total: Float64(10)},
		FetchedAt:     old,
		LastAttemptAt: time.Now().Add(-30 * time.Second),
	}
	if err := writeCacheEntryRaw(path, entry); err != nil {
		t.Fatal(err)
	}

	noop := &NoopSpawner{}
	p := &CachedProvider{
		Inner:      fakeProvider{name: "test", q: Quota{Provider: "test", Used: Float64(2), Total: Float64(10), FetchedAt: timeNow()}},
		Path:       path,
		TTL:        10 * time.Minute,
		RefreshAge: 90 * time.Second,
		Spawner:    noop,
	}

	// First Fetch: cache stale, cooldown inactive, but LastAttemptAt
	// is within refresh window → throttle, no spawn.
	_, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if noop.Calls != 0 {
		t.Fatalf("expected 0 spawns (throttled by LastAttemptAt within window), got %d", noop.Calls)
	}
}

// TestKickBackgroundRefreshNotThrottledAfterWindow verifies that once
// LastAttemptAt is outside the RefreshAge window, spawn resumes.
func TestKickBackgroundRefreshNotThrottledAfterWindow(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")

	// Seed a cache that is stale with an old last_attempt_at
	// (2 min ago — past the 90s RefreshAge window).
	old := time.Now().Add(-3 * time.Minute)
	entry := cacheEntry{
		Quota:         Quota{Provider: "test", Used: Float64(1), Total: Float64(10)},
		FetchedAt:     old,
		LastAttemptAt: time.Now().Add(-2 * time.Minute),
	}
	if err := writeCacheEntryRaw(path, entry); err != nil {
		t.Fatal(err)
	}

	noop := &NoopSpawner{}
	p := &CachedProvider{
		Inner:      fakeProvider{name: "test", q: Quota{Provider: "test", Used: Float64(2), Total: Float64(10), FetchedAt: timeNow()}},
		Path:       path,
		TTL:        10 * time.Minute,
		RefreshAge: 90 * time.Second,
		Spawner:    noop,
	}

	// Fetch: LastAttemptAt is outside refresh window → spawn allowed.
	_, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if noop.Calls != 1 {
		t.Fatalf("expected 1 spawn (LastAttemptAt outside window), got %d", noop.Calls)
	}
}

// TestSWROnlyNoUnavailableOnNonCookieFailure verifies that a stale
// cache WITHOUT a cooldown (simulating a non-cookie failure where
// FetchedAt never advances) does NOT set Unavailable.
func TestSWROnlyNoUnavailableOnNonCookieFailure(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")

	// Simulate a non-cookie failure: cache is stale (3 min old,
	// past 2-min TTL), but no cooldown — the last refresh failed
	// for a non-cookie reason.
	// Only LastAttemptAt is set for throttling purposes.
	oldFetch := time.Now().Add(-3 * time.Minute)
	entry := cacheEntry{
		Quota:         Quota{Provider: "test", Used: Float64(100), Total: Float64(7000)},
		FetchedAt:     oldFetch,
		LastAttemptAt: time.Now().Add(-30 * time.Second),
	}
	if err := writeCacheEntryRaw(path, entry); err != nil {
		t.Fatal(err)
	}

	noop := &NoopSpawner{}
	p := &CachedProvider{
		Inner:      fetchIsFatal{t: t},
		Path:       path,
		TTL:        120 * time.Second, // cache is past TTL
		RefreshAge: 90 * time.Second,
		SWROnly:    true,
		Spawner:    noop,
	}

	q, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Stale — yes.
	if !q.Stale {
		t.Fatal("stale cache past TTL must be marked stale")
	}
	// Unavailable — NO. Non-cookie failure, no cooldown → healthy.
	if q.Unavailable {
		t.Fatal("non-cookie failure (no cooldown) must NOT set Unavailable")
	}
	// Spawn must NOT be kicked (throttled by LastAttemptAt within window).
	if noop.Calls != 0 {
		t.Fatalf("expected 0 spawns (throttled), got %d", noop.Calls)
	}
}

// TestSWROnlyCooldownStillSetsUnavailable verifies the existing behavior:
// when a cooldown IS active, Unavailable=true.
func TestSWROnlyCooldownStillSetsUnavailable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")

	oldFetch := time.Now().Add(-3 * time.Minute)
	entry := cacheEntry{
		Quota:         Quota{Provider: "test", Used: Float64(100), Total: Float64(7000)},
		FetchedAt:     oldFetch,
		CooldownUntil: time.Now().Add(5 * time.Minute), // active cooldown
	}
	if err := writeCacheEntryRaw(path, entry); err != nil {
		t.Fatal(err)
	}

	p := &CachedProvider{
		Inner:      fetchIsFatal{t: t},
		Path:       path,
		TTL:        120 * time.Second,
		RefreshAge: 90 * time.Second,
		SWROnly:    true,
		Spawner:    &NoopSpawner{},
	}

	q, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Cooldown active → Unavailable=true.
	if !q.Unavailable {
		t.Fatal("active cooldown must set Unavailable=true")
	}
	if !q.Stale {
		t.Fatal("active cooldown must set Stale=true")
	}
}

// TestSetCacheLastAttemptAtPreservesExistingData verifies that
// SetCacheLastAttemptAt only stamps the last_attempt_at field and
// preserves all other cache entry data.
func TestSetCacheLastAttemptAtPreservesExistingData(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")

	entry := cacheEntry{
		Quota:         Quota{Provider: "test", Used: Float64(100), Total: Float64(7000)},
		FetchedAt:     time.Now().Add(-1 * time.Minute),
		CooldownUntil: time.Now().Add(5 * time.Minute),
	}
	if err := writeCacheEntryRaw(path, entry); err != nil {
		t.Fatal(err)
	}

	now := time.Now()
	if err := SetCacheLastAttemptAt(path, now, false); err != nil {
		t.Fatal(err)
	}

	// Read back and verify.
	e, ok := readCache(path)
	if !ok {
		t.Fatal("cache should be readable after SetCacheLastAttemptAt")
	}
	if !e.LastAttemptAt.Equal(now) {
		t.Fatalf("LastAttemptAt = %v, want %v", e.LastAttemptAt, now)
	}
	if e.Quota.Used == nil || *e.Quota.Used != 100 {
		t.Fatal("quota data was lost after SetCacheLastAttemptAt")
	}
	if e.CooldownUntil.IsZero() {
		t.Fatal("cooldown was lost after SetCacheLastAttemptAt")
	}
}

// TestKickBackgroundRefreshStampsLastAttemptAtBeforeSpawn verifies
// that a successful spawn path leaves a LastAttemptAt stamp so
// subsequent calls within the refresh window are throttled.
func TestKickBackgroundRefreshStampsLastAttemptAtBeforeSpawn(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")

	old := Quota{Provider: "test", Used: Float64(1), Total: Float64(10), FetchedAt: timeNow().Add(-3 * time.Minute)}
	if err := writeCache(path, old); err != nil {
		t.Fatal(err)
	}

	noop := &NoopSpawner{}
	p := &CachedProvider{
		Inner:      fakeProvider{name: "test", q: Quota{Provider: "test", Used: Float64(2), Total: Float64(10), FetchedAt: timeNow()}},
		Path:       path,
		TTL:        10 * time.Minute,
		RefreshAge: 90 * time.Second,
		Spawner:    noop,
	}

	// Fetch: cache stale, no LastAttemptAt → should spawn.
	_, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if noop.Calls != 1 {
		t.Fatalf("expected 1 spawn on first call, got %d", noop.Calls)
	}

	// Verify LastAttemptAt was stamped.
	entry, ok := readCache(path)
	if !ok {
		t.Fatal("cache should exist after spawn")
	}
	if entry.LastAttemptAt.IsZero() {
		t.Fatal("LastAttemptAt should have been stamped by kickBackgroundRefresh")
	}

	// Second Fetch within refresh window → throttle, no spawn.
	noop.Calls = 0
	_, err = p.Fetch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if noop.Calls != 0 {
		t.Fatalf("expected 0 spawns on second call (throttled), got %d", noop.Calls)
	}
}

// --- Lock ordering and no-cache throttle tests ---

// TestKickNoStampOrSpawnWhenLockHeld verifies the lock ordering fix:
// when another process holds the refresh lock, kickBackgroundRefresh
// does NOT stamp LastAttemptAt and does NOT spawn. The stamp is only
// written AFTER the lock is acquired, ensuring no lost-update race
// with the child's cache writes.
func TestKickNoStampOrSpawnWhenLockHeld(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")
	lockPath := path + ".refresh.lock"

	// Write a cache that is stale enough to trigger SWR.
	old := Quota{Provider: "test", Used: Float64(1), Total: Float64(10), FetchedAt: timeNow().Add(-3 * time.Minute)}
	if err := writeCache(path, old); err != nil {
		t.Fatal(err)
	}

	// Simulate another process holding the lock by creating a fake
	// lockfile with a different token.
	fakeLock, err := AcquireRefreshLock(lockPath)
	if err != nil {
		t.Fatal(err)
	}
	defer fakeLock.Release()

	noop := &NoopSpawner{}
	p := &CachedProvider{
		Inner:      fakeProvider{name: "test", q: Quota{Provider: "test", Used: Float64(2), Total: Float64(10), FetchedAt: timeNow()}},
		Path:       path,
		TTL:        10 * time.Minute,
		RefreshAge: 90 * time.Second,
		Spawner:    noop,
	}

	_, err = p.Fetch(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	// Should NOT have spawned (lock was held).
	if noop.Calls != 0 {
		t.Fatalf("expected 0 spawns when lock held, got %d", noop.Calls)
	}

	// Should NOT have stamped LastAttemptAt (stamp happens under lock,
	// and the lock was held).
	entry, ok := readCache(path)
	if !ok {
		t.Fatal("cache should still be readable")
	}
	if !entry.LastAttemptAt.IsZero() {
		t.Fatal("LastAttemptAt should NOT be stamped when lock is held by another process")
	}
}

// TestKickStampsAndSpawnWhenLockFree verifies the happy path: when
// the lock is free, kickBackgroundRefresh stamps LastAttemptAt
// (under the lock) and spawns.
func TestKickStampsAndSpawnWhenLockFree(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")

	old := Quota{Provider: "test", Used: Float64(1), Total: Float64(10), FetchedAt: timeNow().Add(-3 * time.Minute)}
	if err := writeCache(path, old); err != nil {
		t.Fatal(err)
	}

	noop := &NoopSpawner{}
	p := &CachedProvider{
		Inner:      fakeProvider{name: "test", q: Quota{Provider: "test", Used: Float64(2), Total: Float64(10), FetchedAt: timeNow()}},
		Path:       path,
		TTL:        10 * time.Minute,
		RefreshAge: 90 * time.Second,
		Spawner:    noop,
	}

	_, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	if noop.Calls != 1 {
		t.Fatalf("expected 1 spawn when lock free, got %d", noop.Calls)
	}

	// Stamp must be present (written under lock before spawn).
	entry, ok := readCache(path)
	if !ok {
		t.Fatal("cache should exist after spawn")
	}
	if entry.LastAttemptAt.IsZero() {
		t.Fatal("LastAttemptAt should have been stamped under lock")
	}
}

// TestNoCacheThrottlePersistsAcrossRenders verifies that when no
// cache file exists, repeated fast failures (e.g. transient network)
// are throttled to at most one spawn per RefreshAge window. The
// throttle stamp persists even though no full cache entry exists.
func TestNoCacheThrottlePersistsAcrossRenders(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")

	// No cache file exists.

	noop := &NoopSpawner{}
	p := &CachedProvider{
		Inner:      fakeProvider{name: "test", q: Quota{Provider: "test", Used: Float64(1), Total: Float64(10), FetchedAt: timeNow()}},
		Path:       path,
		TTL:        10 * time.Minute,
		RefreshAge: 90 * time.Second,
		SWROnly:    true,
		Spawner:    noop,
	}

	// First fetch: no cache → kick spawn (SWROnly no-cache path).
	_, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if noop.Calls != 1 {
		t.Fatalf("expected 1 spawn on first no-cache call, got %d", noop.Calls)
	}

	// The lock was acquired and released (NoopSpawner). Verify the
	// throttle stamp was written even though no cache existed before.
	stamp := readCacheLastAttemptAt(path)
	if stamp.IsZero() {
		t.Fatal("expected LastAttemptAt stamp to be created for no-cache throttle")
	}

	// BUT: a minimal LastAttemptAt-only file must NOT render as
	// quota data — ReadCache must reject it.
	_, hasCache := ReadCache(path)
	if hasCache {
		t.Fatal("LastAttemptAt-only entry must NOT render as quota data")
	}

	// Second fetch within the throttle window: should be throttled,
	// no spawn.
	noop.Calls = 0
	_, err = p.Fetch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if noop.Calls != 0 {
		t.Fatalf("expected 0 spawns on second no-cache call (throttled), got %d", noop.Calls)
	}

	// The stamp should still be there.
	stamp2 := readCacheLastAttemptAt(path)
	if stamp2.IsZero() {
		t.Fatal("expected LastAttemptAt stamp to persist after throttle check")
	}
}

// TestNoCacheThrottleExpiresAfterWindow verifies that after the
// throttle window elapses, spawns resume even with no cache.
func TestNoCacheThrottleExpiresAfterWindow(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")

	// Create a minimal LastAttemptAt-only entry (simulating a
	// previous throttle stamp from a no-cache scenario).
	oldStamp := time.Now().Add(-2 * time.Minute) // 120s ago, past 90s window
	entry := cacheEntry{LastAttemptAt: oldStamp}
	raw, err := json.MarshalIndent(entry, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}

	noop := &NoopSpawner{}
	p := &CachedProvider{
		Inner:      fakeProvider{name: "test", q: Quota{Provider: "test", Used: Float64(1), Total: Float64(10), FetchedAt: timeNow()}},
		Path:       path,
		TTL:        10 * time.Minute,
		RefreshAge: 90 * time.Second,
		SWROnly:    true,
		Spawner:    noop,
	}

	// Fetch: no cache data (ReadCache rejects LastAttemptAt-only),
	// but throttle stamp is old → throttle passed → spawn.
	_, err = p.Fetch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if noop.Calls != 1 {
		t.Fatalf("expected 1 spawn after throttle window expired, got %d", noop.Calls)
	}
}

// TestAcquireRefreshLockCreatesParentDir verifies that on a fresh
// machine with no quota/ directory, AcquireRefreshLock creates the
// parent directory before trying to create the lockfile. Without
// this, the first refresh would never spawn.
func TestAcquireRefreshLockCreatesParentDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nonexistent", "quota")
	lockPath := filepath.Join(dir, "test.json.refresh.lock")

	lock, err := AcquireRefreshLock(lockPath)
	if err != nil {
		t.Fatalf("AcquireRefreshLock should create parent dirs: %v", err)
	}
	defer lock.Release()

	// Verify the directory was created.
	fi, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("parent dir should exist: %v", err)
	}
	if !fi.IsDir() {
		t.Fatal("parent dir should be a directory")
	}

	// Verify the lockfile exists.
	if _, err := os.Stat(lockPath); err != nil {
		t.Fatal("lockfile should exist")
	}
}

// TestNoCacheFirstRefreshSpawnsWithFreshDir verifies the end-to-end
// scenario: on a fresh machine with no quota/ dir and no cache,
// the first render kicks a refresh (dir is created, stamp is
// written, spawn happens). The immediate next render is throttled.
func TestNoCacheFirstRefreshSpawnsWithFreshDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nonexistent", "quota")
	cachePath := filepath.Join(dir, "test.json")

	// No quota/ dir, no cache file — fresh machine.

	noop := &NoopSpawner{}
	p := &CachedProvider{
		Inner:      fakeProvider{name: "test", q: Quota{Provider: "test", Used: Float64(1), Total: Float64(10), FetchedAt: timeNow()}},
		Path:       cachePath,
		TTL:        10 * time.Minute,
		RefreshAge: 90 * time.Second,
		SWROnly:    true,
		Spawner:    noop,
	}

	// First fetch: no cache, no dir → should create dir, stamp, spawn.
	_, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if noop.Calls != 1 {
		t.Fatalf("expected 1 spawn on first no-cache call, got %d", noop.Calls)
	}

	// Directory must exist.
	fi, err := os.Stat(dir)
	if err != nil || !fi.IsDir() {
		t.Fatalf("quota dir should exist after first fetch: %v", err)
	}

	// Stamp must be present.
	stamp := readCacheLastAttemptAt(cachePath)
	if stamp.IsZero() {
		t.Fatal("LastAttemptAt stamp should exist after first fetch")
	}

	// Second fetch within throttle window → throttled, no spawn.
	noop.Calls = 0
	_, err = p.Fetch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if noop.Calls != 0 {
		t.Fatalf("expected 0 spawns on second call (throttled), got %d", noop.Calls)
	}
}

func TestQuotaRefreshProviderCommand(t *testing.T) {
	tmpDir := t.TempDir()
	cachePath := filepath.Join(tmpDir, "quota", "kimi-coding.json")
	lockPath := cachePath + ".refresh.lock"

	// Acquire the lock first (as the parent DefaultSpawner would).
	lock, err := AcquireRefreshLock(lockPath)
	if err != nil {
		t.Fatal(err)
	}

	t.Setenv("FORGE_REFRESH_CACHE_PATH", cachePath)
	t.Setenv("FORGE_REFRESH_LOCK_PATH", lockPath)
	t.Setenv("FORGE_REFRESH_LOCK_TOKEN", lock.Token)

	// Seed old cache to prove it gets overwritten.
	old := Quota{
		Provider:  "kimi-coding",
		Used:      Float64(100),
		Total:     Float64(1000),
		FetchedAt: timeNow().Add(-1 * time.Hour),
	}
	if err := writeCache(cachePath, old); err != nil {
		t.Fatal(err)
	}

	deps := CommandDeps{
		DataDir:              tmpDir,
		LoadConfig:           func() (ConfigInfo, []string, error) { return ConfigInfo{}, nil, nil },
		LoadBilling:          func() BillingInfo { return BillingInfo{DefaultQuotaTotal: 7000} },
		ResolveBigModelToken: func() string { return "" },
		ResolveKimiToken:     func() string { return "" },
		CodexBarEnabled:      func() bool { return false },
		ProviderForOverride: func(name string, billing BillingInfo) Provider {
			return fakeProvider{
				name: "kimi-coding",
				q: Quota{
					Provider:  "kimi-coding",
					Used:      Float64(200),
					Total:     Float64(2000),
					FetchedAt: timeNow(),
				},
			}
		},
	}

	code := Command(deps, []string{"refresh-provider", "kimi-coding"})
	if code != 0 {
		t.Fatalf("expected exit code 0 from refresh-provider command, got %d", code)
	}

	// Verify cache was atomically written with fresh data.
	q, ok := ReadCache(cachePath)
	if !ok {
		t.Fatal("cache should exist after refresh-provider")
	}
	if q.Used == nil || *q.Used != 200 {
		t.Fatalf("expected used=200, got %#v", q.Used)
	}
	if q.Total == nil || *q.Total != 2000 {
		t.Fatalf("expected total=2000, got %#v", q.Total)
	}
	if q.FetchedAt.IsZero() {
		t.Fatal("FetchedAt should be set after refresh")
	}
	if q.FetchedAt.Before(time.Now().Add(-10 * time.Second)) {
		t.Fatalf("FetchedAt should be recent, got %v", q.FetchedAt)
	}

	// Verify lock was released.
	if _, err := os.Stat(lockPath); err == nil {
		t.Fatal("lockfile should have been released after successful refresh")
	}
}

func TestQuotaRefreshProviderCommandFailure(t *testing.T) {
	tmpDir := t.TempDir()
	cachePath := filepath.Join(tmpDir, "quota", "kimi-coding.json")
	lockPath := cachePath + ".refresh.lock"

	lock, err := AcquireRefreshLock(lockPath)
	if err != nil {
		t.Fatal(err)
	}

	t.Setenv("FORGE_REFRESH_CACHE_PATH", cachePath)
	t.Setenv("FORGE_REFRESH_LOCK_PATH", lockPath)
	t.Setenv("FORGE_REFRESH_LOCK_TOKEN", lock.Token)

	deps := CommandDeps{
		DataDir:              tmpDir,
		LoadConfig:           func() (ConfigInfo, []string, error) { return ConfigInfo{}, nil, nil },
		LoadBilling:          func() BillingInfo { return BillingInfo{DefaultQuotaTotal: 7000} },
		ResolveBigModelToken: func() string { return "" },
		ResolveKimiToken:     func() string { return "" },
		CodexBarEnabled:      func() bool { return false },
		ProviderForOverride: func(name string, billing BillingInfo) Provider {
			return fakeProvider{name: "kimi-coding", err: errors.New("simulated provider failure")}
		},
	}

	code := Command(deps, []string{"refresh-provider", "kimi-coding"})
	if code == 0 {
		t.Fatal("expected nonzero exit code on fetch failure, got 0")
	}

	// Verify failure marker was written.
	entry, ok := readCache(cachePath)
	if !ok {
		t.Fatal("cache should contain a failure marker after fetch failure")
	}
	if entry.FailedAt.IsZero() {
		t.Fatal("expected FailedAt to be set in failure marker")
	}
	if !strings.Contains(entry.Error, "simulated provider failure") {
		t.Fatalf("expected error message in failure marker, got %q", entry.Error)
	}

	// Verify lock was released.
	if _, err := os.Stat(lockPath); err == nil {
		t.Fatal("lockfile should have been released after failure")
	}
}

func TestQuotaRefreshProviderCommandMissingArg(t *testing.T) {
	code := Command(CommandDeps{}, []string{"refresh-provider"})
	if code == 0 {
		t.Fatal("expected nonzero exit code when provider arg is missing")
	}
}

func TestQuotaRefreshProviderCommandExtraArg(t *testing.T) {
	code := Command(CommandDeps{}, []string{"refresh-provider", "kimi-coding", "extra"})
	if code == 0 {
		t.Fatal("expected nonzero exit code when extra arg is provided")
	}
}

func TestQuotaRefreshProviderCommandUnknownProvider(t *testing.T) {
	code := Command(CommandDeps{}, []string{"refresh-provider", "unknown-provider"})
	if code == 0 {
		t.Fatal("expected nonzero exit code for unknown provider")
	}
}

func TestQuotaRefreshProviderCacheWriteFailure(t *testing.T) {
	tmpDir := t.TempDir()
	cachePath := filepath.Join(tmpDir, "quota", "kimi-coding.json")
	lockPath := cachePath + ".refresh.lock"

	lock, err := AcquireRefreshLock(lockPath)
	if err != nil {
		t.Fatal(err)
	}

	t.Setenv("FORGE_REFRESH_CACHE_PATH", cachePath)
	t.Setenv("FORGE_REFRESH_LOCK_PATH", lockPath)
	t.Setenv("FORGE_REFRESH_LOCK_TOKEN", lock.Token)

	deps := CommandDeps{
		DataDir:              tmpDir,
		LoadConfig:           func() (ConfigInfo, []string, error) { return ConfigInfo{}, nil, nil },
		LoadBilling:          func() BillingInfo { return BillingInfo{DefaultQuotaTotal: 7000} },
		ResolveBigModelToken: func() string { return "" },
		ResolveKimiToken:     func() string { return "" },
		CodexBarEnabled:      func() bool { return false },
		ProviderForOverride: func(name string, billing BillingInfo) Provider {
			return fakeProvider{
				name: "kimi-coding",
				q: Quota{
					Provider:  "kimi-coding",
					Used:      Float64(200),
					Total:     Float64(2000),
					FetchedAt: timeNow(),
				},
			}
		},
		WriteCache: func(path string, q Quota) error {
			return errors.New("simulated write failure")
		},
	}

	code := Command(deps, []string{"refresh-provider", "kimi-coding"})
	if code == 0 {
		t.Fatal("expected nonzero exit code on cache write failure")
	}

	// Verify lock was released despite write failure.
	if _, err := os.Stat(lockPath); err == nil {
		t.Fatal("lockfile should have been released after write failure")
	}
}

// refreshReclaimProvider is a provider whose Fetch replaces the lockfile
// token with a newer owner's token before returning. It deterministically
// simulates a stale reclaim landing immediately after the long fetch and
// before the refresh-provider worker's guarded cache write or guarded
// failure-marker write, with no sleeps.
type refreshReclaimProvider struct {
	q        Quota
	err      error
	lockPath string
	newToken string
}

func (p refreshReclaimProvider) Name() string { return "refresh" }
func (p refreshReclaimProvider) Fetch(ctx context.Context) (Quota, error) {
	if err := os.WriteFile(p.lockPath, []byte(p.newToken+"\n"), 0o600); err != nil {
		return Quota{}, err
	}
	if p.err != nil {
		return Quota{}, p.err
	}
	return p.q, nil
}

// TestQuotaRefreshProviderStaleReclaimBeforeCacheWriteSkipsWrite verifies
// the check/write TOCTOU invariant for the generic refresh-provider worker:
// when a newer owner reclaims the lock immediately after the long fetch and
// before the guarded successful cache write, the write callback is not
// executed, the newer cache bytes are preserved unchanged, and the newer
// token is not released.
func TestQuotaRefreshProviderStaleReclaimBeforeCacheWriteSkipsWrite(t *testing.T) {
	tmpDir := t.TempDir()
	cachePath := filepath.Join(tmpDir, "quota", "kimi-coding.json")
	lockPath := cachePath + ".refresh.lock"

	lock, err := AcquireRefreshLock(lockPath)
	if err != nil {
		t.Fatal(err)
	}

	// A newer owner's cache must remain byte-for-byte unchanged by the
	// stale worker.
	newerCache := []byte(`{"quota":{"provider":"kimi-coding","used":777,"total":7777},"fetched_at":"2026-01-01T00:00:00Z"}`)
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cachePath, newerCache, 0o600); err != nil {
		t.Fatal(err)
	}

	t.Setenv("FORGE_REFRESH_CACHE_PATH", cachePath)
	t.Setenv("FORGE_REFRESH_LOCK_PATH", lockPath)
	t.Setenv("FORGE_REFRESH_LOCK_TOKEN", lock.Token)

	newerToken := "99999-newer-owner"
	var writeCalls int
	deps := CommandDeps{
		DataDir:              tmpDir,
		LoadConfig:           func() (ConfigInfo, []string, error) { return ConfigInfo{}, nil, nil },
		LoadBilling:          func() BillingInfo { return BillingInfo{DefaultQuotaTotal: 7000} },
		ResolveBigModelToken: func() string { return "" },
		ResolveKimiToken:     func() string { return "" },
		CodexBarEnabled:      func() bool { return false },
		ProviderForOverride: func(name string, billing BillingInfo) Provider {
			return refreshReclaimProvider{
				q:        Quota{Provider: "kimi-coding", Used: Float64(200), Total: Float64(2000), FetchedAt: timeNow()},
				lockPath: lockPath,
				newToken: newerToken,
			}
		},
		WriteCache: func(path string, q Quota) error {
			writeCalls++
			return WriteCache(path, q)
		},
	}

	code := Command(deps, []string{"refresh-provider", "kimi-coding"})
	if code != 1 {
		t.Fatalf("refresh-provider exit code = %d, want 1 (ownership lost before cache write)", code)
	}
	if writeCalls != 0 {
		t.Fatalf("guarded cache write must not run after reclaim, got %d calls", writeCalls)
	}
	got, err := os.ReadFile(cachePath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, newerCache) {
		t.Fatalf("newer cache changed by stale worker: %q", got)
	}
	data, err := os.ReadFile(lockPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(data)) != newerToken {
		t.Fatalf("newer lock token was released/changed: %q", strings.TrimSpace(string(data)))
	}
}

// TestQuotaRefreshProviderStaleReclaimBeforeFailureMarkerSkipsWrite verifies
// the same check/write TOCTOU invariant for the generic refresh-provider
// failure path: when a newer owner reclaims the lock immediately after the
// long fetch and before the guarded failure-marker write, the marker write is
// skipped, the newer marker bytes are preserved unchanged, and the newer
// token is not released.
func TestQuotaRefreshProviderStaleReclaimBeforeFailureMarkerSkipsWrite(t *testing.T) {
	tmpDir := t.TempDir()
	cachePath := filepath.Join(tmpDir, "quota", "kimi-coding.json")
	lockPath := cachePath + ".refresh.lock"

	lock, err := AcquireRefreshLock(lockPath)
	if err != nil {
		t.Fatal(err)
	}

	// A newer owner's failure marker must remain byte-for-byte unchanged
	// by the stale worker's failure-marker write.
	newerMarker := []byte(`{"failed_at":"2026-01-01T00:00:00Z","error":"newer owner failure"}`)
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cachePath, newerMarker, 0o600); err != nil {
		t.Fatal(err)
	}

	t.Setenv("FORGE_REFRESH_CACHE_PATH", cachePath)
	t.Setenv("FORGE_REFRESH_LOCK_PATH", lockPath)
	t.Setenv("FORGE_REFRESH_LOCK_TOKEN", lock.Token)

	newerToken := "99999-newer-owner"
	deps := CommandDeps{
		DataDir:              tmpDir,
		LoadConfig:           func() (ConfigInfo, []string, error) { return ConfigInfo{}, nil, nil },
		LoadBilling:          func() BillingInfo { return BillingInfo{DefaultQuotaTotal: 7000} },
		ResolveBigModelToken: func() string { return "" },
		ResolveKimiToken:     func() string { return "" },
		CodexBarEnabled:      func() bool { return false },
		ProviderForOverride: func(name string, billing BillingInfo) Provider {
			return refreshReclaimProvider{
				err:      errors.New("simulated provider failure"),
				lockPath: lockPath,
				newToken: newerToken,
			}
		},
	}

	code := Command(deps, []string{"refresh-provider", "kimi-coding"})
	if code != 1 {
		t.Fatalf("refresh-provider exit code = %d, want 1 (ownership lost before failure-marker write)", code)
	}
	got, err := os.ReadFile(cachePath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, newerMarker) {
		t.Fatalf("newer failure marker changed by stale worker: %q", got)
	}
	data, err := os.ReadFile(lockPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(data)) != newerToken {
		t.Fatalf("newer lock token was released/changed: %q", strings.TrimSpace(string(data)))
	}
}

func TestQuotaRefreshProviderExactCanonicalRejection(t *testing.T) {
	// Case variant must be rejected by exact pool map lookup.
	code := Command(CommandDeps{}, []string{"refresh-provider", "Kimi-Coding"})
	if code == 0 {
		t.Fatal("expected nonzero exit code for case-mismatched provider name")
	}

	// Whitespace variant must be rejected.
	code = Command(CommandDeps{}, []string{"refresh-provider", "kimi-coding "})
	if code == 0 {
		t.Fatal("expected nonzero exit code for whitespace-padded provider name")
	}
}

func TestQuotaRefreshProviderLockPathMismatch(t *testing.T) {
	tmpDir := t.TempDir()
	cachePath := filepath.Join(tmpDir, "quota", "kimi-coding.json")

	t.Setenv("FORGE_REFRESH_CACHE_PATH", cachePath)
	// Set a lock path that doesn't match expected cachePath + .refresh.lock
	t.Setenv("FORGE_REFRESH_LOCK_PATH", filepath.Join(tmpDir, "quota", "wrong.lock"))
	t.Setenv("FORGE_REFRESH_LOCK_TOKEN", "token")

	deps := CommandDeps{
		DataDir:     tmpDir,
		LoadBilling: func() BillingInfo { return BillingInfo{} },
	}

	code := Command(deps, []string{"refresh-provider", "kimi-coding"})
	if code == 0 {
		t.Fatal("expected nonzero exit code on lock path mismatch")
	}
}

func TestQuotaRefreshProviderEmptyDataDir(t *testing.T) {
	code := Command(CommandDeps{}, []string{"refresh-provider", "kimi-coding"})
	if code == 0 {
		t.Fatal("expected nonzero exit code when DataDir is empty")
	}
}

// TestQuotaRefreshProviderFailurePreservesStaleQuota verifies that on
// detached fetch failure, an existing valid cache entry (with FetchedAt)
// is preserved unchanged — including the pre-spawn LastAttemptAt stamp.
func TestQuotaRefreshProviderFailurePreservesStaleQuota(t *testing.T) {
	tmpDir := t.TempDir()
	cachePath := filepath.Join(tmpDir, "quota", "kimi-coding.json")
	lockPath := cachePath + ".refresh.lock"

	// Seed a stale valid quota with a LastAttemptAt throttle stamp.
	staleFetchedAt := time.Now().Add(-3 * time.Minute)
	staleLastAttemptAt := time.Now().Add(-60 * time.Second)
	entry := cacheEntry{
		Quota:         Quota{Provider: "kimi-coding", Used: Float64(100), Total: Float64(1000)},
		FetchedAt:     staleFetchedAt,
		LastAttemptAt: staleLastAttemptAt,
	}
	raw, _ := json.MarshalIndent(entry, "", "  ")
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cachePath, raw, 0o600); err != nil {
		t.Fatal(err)
	}

	lock, err := AcquireRefreshLock(lockPath)
	if err != nil {
		t.Fatal(err)
	}

	t.Setenv("FORGE_REFRESH_CACHE_PATH", cachePath)
	t.Setenv("FORGE_REFRESH_LOCK_PATH", lockPath)
	t.Setenv("FORGE_REFRESH_LOCK_TOKEN", lock.Token)

	deps := CommandDeps{
		DataDir:              tmpDir,
		LoadConfig:           func() (ConfigInfo, []string, error) { return ConfigInfo{}, nil, nil },
		LoadBilling:          func() BillingInfo { return BillingInfo{DefaultQuotaTotal: 7000} },
		ResolveBigModelToken: func() string { return "" },
		ResolveKimiToken:     func() string { return "" },
		CodexBarEnabled:      func() bool { return false },
		ProviderForOverride: func(name string, billing BillingInfo) Provider {
			return fakeProvider{name: "kimi-coding", err: errors.New("simulated failure")}
		},
	}

	code := Command(deps, []string{"refresh-provider", "kimi-coding"})
	if code == 0 {
		t.Fatal("expected nonzero exit code on fetch failure")
	}

	// The stale valid quota must be preserved unchanged.
	e, ok := readCache(cachePath)
	if !ok {
		t.Fatal("cache should still be readable after failure")
	}
	if e.Quota.Used == nil || *e.Quota.Used != 100 {
		t.Fatal("stale quota data was destroyed by writeRefreshFailure")
	}
	if !e.FetchedAt.Equal(staleFetchedAt) {
		t.Fatalf("FetchedAt changed: old=%v, new=%v", staleFetchedAt, e.FetchedAt)
	}
	if !e.LastAttemptAt.Equal(staleLastAttemptAt) {
		t.Fatalf("LastAttemptAt was overwritten: old=%v, new=%v", staleLastAttemptAt, e.LastAttemptAt)
	}

	// Lock must be released.
	if _, err := os.Stat(lockPath); err == nil {
		t.Fatal("lockfile should have been released after failure")
	}
}

// TestQuotaRefreshProviderNoCacheFailurePreservesLastAttemptAt verifies
// that when no valid cache exists (LastAttemptAt-only stamp), a detached
// fetch failure produces a quota-free failure marker preserving the
// throttle metadata.
func TestQuotaRefreshProviderNoCacheFailurePreservesLastAttemptAt(t *testing.T) {
	tmpDir := t.TempDir()
	cachePath := filepath.Join(tmpDir, "quota", "kimi-coding.json")
	lockPath := cachePath + ".refresh.lock"

	// Create a LastAttemptAt-only stamp (no valid quota).
	stamp := time.Now().Add(-30 * time.Second)
	throttleEntry := cacheEntry{LastAttemptAt: stamp}
	raw, _ := json.MarshalIndent(throttleEntry, "", "  ")
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cachePath, raw, 0o600); err != nil {
		t.Fatal(err)
	}

	lock, err := AcquireRefreshLock(lockPath)
	if err != nil {
		t.Fatal(err)
	}

	t.Setenv("FORGE_REFRESH_CACHE_PATH", cachePath)
	t.Setenv("FORGE_REFRESH_LOCK_PATH", lockPath)
	t.Setenv("FORGE_REFRESH_LOCK_TOKEN", lock.Token)

	deps := CommandDeps{
		DataDir:              tmpDir,
		LoadConfig:           func() (ConfigInfo, []string, error) { return ConfigInfo{}, nil, nil },
		LoadBilling:          func() BillingInfo { return BillingInfo{DefaultQuotaTotal: 7000} },
		ResolveBigModelToken: func() string { return "" },
		ResolveKimiToken:     func() string { return "" },
		CodexBarEnabled:      func() bool { return false },
		ProviderForOverride: func(name string, billing BillingInfo) Provider {
			return fakeProvider{name: "kimi-coding", err: errors.New("simulated failure")}
		},
	}

	code := Command(deps, []string{"refresh-provider", "kimi-coding"})
	if code == 0 {
		t.Fatal("expected nonzero exit code on fetch failure")
	}

	// Must produce a failure marker preserving the previous LastAttemptAt.
	e, ok := readCache(cachePath)
	if !ok {
		t.Fatal("cache should contain a failure marker after no-cache failure")
	}
	if e.FailedAt.IsZero() {
		t.Fatal("expected FailedAt to be set in failure marker")
	}
	if !strings.Contains(e.Error, "simulated failure") {
		t.Fatalf("expected error message, got %q", e.Error)
	}
	if e.LastAttemptAt.IsZero() {
		t.Fatal("LastAttemptAt throttle stamp was lost")
	}
}

// TestQuotaRefreshProviderNoCacheAtAllFailurePreservesNothing verifies
// that when no cache file of any kind exists, a detached fetch failure
// writes a clean failure marker (FailedAt + Error, no LastAttemptAt).
func TestQuotaRefreshProviderNoCacheAtAllFailurePreservesNothing(t *testing.T) {
	tmpDir := t.TempDir()
	cachePath := filepath.Join(tmpDir, "quota", "kimi-coding.json")
	lockPath := cachePath + ".refresh.lock"

	lock, err := AcquireRefreshLock(lockPath)
	if err != nil {
		t.Fatal(err)
	}

	t.Setenv("FORGE_REFRESH_CACHE_PATH", cachePath)
	t.Setenv("FORGE_REFRESH_LOCK_PATH", lockPath)
	t.Setenv("FORGE_REFRESH_LOCK_TOKEN", lock.Token)

	deps := CommandDeps{
		DataDir:              tmpDir,
		LoadConfig:           func() (ConfigInfo, []string, error) { return ConfigInfo{}, nil, nil },
		LoadBilling:          func() BillingInfo { return BillingInfo{DefaultQuotaTotal: 7000} },
		ResolveBigModelToken: func() string { return "" },
		ResolveKimiToken:     func() string { return "" },
		CodexBarEnabled:      func() bool { return false },
		ProviderForOverride: func(name string, billing BillingInfo) Provider {
			return fakeProvider{name: "kimi-coding", err: errors.New("simulated failure")}
		},
	}

	code := Command(deps, []string{"refresh-provider", "kimi-coding"})
	if code == 0 {
		t.Fatal("expected nonzero exit code on fetch failure")
	}

	e, ok := readCache(cachePath)
	if !ok {
		t.Fatal("cache should contain a failure marker")
	}
	if e.FailedAt.IsZero() {
		t.Fatal("expected FailedAt to be set")
	}
	if !strings.Contains(e.Error, "simulated failure") {
		t.Fatalf("expected error message, got %q", e.Error)
	}

	// Lock must be released.
	if _, err := os.Stat(lockPath); err == nil {
		t.Fatal("lockfile should have been released after failure")
	}
}

// TestQuotaRefreshProviderCachePathMismatch verifies that a cache path
// mismatch with a valid canonical owned lock still releases the lock.
func TestQuotaRefreshProviderCachePathMismatch(t *testing.T) {
	tmpDir := t.TempDir()
	lockPath := filepath.Join(tmpDir, "quota", "kimi-coding.json.refresh.lock")

	lock, err := AcquireRefreshLock(lockPath)
	if err != nil {
		t.Fatal(err)
	}

	// Set a different cache path than expected.
	t.Setenv("FORGE_REFRESH_CACHE_PATH", filepath.Join(tmpDir, "quota", "wrong.json"))
	t.Setenv("FORGE_REFRESH_LOCK_PATH", lockPath)
	t.Setenv("FORGE_REFRESH_LOCK_TOKEN", lock.Token)

	deps := CommandDeps{
		DataDir:     tmpDir,
		LoadBilling: func() BillingInfo { return BillingInfo{} },
	}

	code := Command(deps, []string{"refresh-provider", "kimi-coding"})
	if code == 0 {
		t.Fatal("expected nonzero exit code on cache path mismatch")
	}

	// Lock must be released (ownership was acquired, then cache path
	// validation failed — the deferred Release runs).
	if _, err := os.Stat(lockPath); err == nil {
		t.Fatal("lockfile should have been released after cache path mismatch")
	}
}

// TestQuotaRefreshProviderMissingCachePath verifies that when all lock
// credentials are valid but FORGE_REFRESH_CACHE_PATH is absent, the
// owned lock is still released (nonzero exit, lock cleaned up).
func TestQuotaRefreshProviderMissingCachePath(t *testing.T) {
	tmpDir := t.TempDir()
	lockPath := filepath.Join(tmpDir, "quota", "kimi-coding.json.refresh.lock")

	lock, err := AcquireRefreshLock(lockPath)
	if err != nil {
		t.Fatal(err)
	}

	// Set a valid lock path/token but omit the cache path entirely.
	t.Setenv("FORGE_REFRESH_LOCK_PATH", lockPath)
	t.Setenv("FORGE_REFRESH_LOCK_TOKEN", lock.Token)
	// FORGE_REFRESH_CACHE_PATH is deliberately not set.

	deps := CommandDeps{
		DataDir:     tmpDir,
		LoadBilling: func() BillingInfo { return BillingInfo{} },
	}

	code := Command(deps, []string{"refresh-provider", "kimi-coding"})
	if code == 0 {
		t.Fatal("expected nonzero exit code when cache path is missing")
	}

	// Lock must be released despite the missing cache path (ownership
	// was established before the cache-path check).
	if _, err := os.Stat(lockPath); err == nil {
		t.Fatal("lockfile should have been released after missing cache path")
	}
}

func TestQuotaRefreshProviderRejectsDotSegmentAlias(t *testing.T) {
	tmpDir := t.TempDir()
	canonicalCachePath := filepath.Join(tmpDir, "quota", "kimi-coding.json")
	lockPath := canonicalCachePath + ".refresh.lock"

	lock, err := AcquireRefreshLock(lockPath)
	if err != nil {
		t.Fatal(err)
	}

	// Construct a raw dot-segment path using string concatenation and
	// the platform separator — NOT filepath.Join/Clean, which would
	// normalize the .. away. The raw string must not be byte-equal to
	// canonical, but filepath.Clean must resolve to canonical.
	sep := string(os.PathSeparator)
	dotAlias := tmpDir + sep + "other" + sep + ".." + sep + "quota" + sep + "kimi-coding.json"

	// Sanity: raw alias differs from canonical, but cleans to canonical.
	if dotAlias == canonicalCachePath {
		t.Fatal("dot-segment alias must differ from canonical path as raw strings")
	}
	if cleaned := filepath.Clean(dotAlias); cleaned != canonicalCachePath {
		t.Fatalf("filepath.Clean(dotAlias) = %q, want %q", cleaned, canonicalCachePath)
	}

	t.Setenv("FORGE_REFRESH_CACHE_PATH", dotAlias)
	t.Setenv("FORGE_REFRESH_LOCK_PATH", lockPath)
	t.Setenv("FORGE_REFRESH_LOCK_TOKEN", lock.Token)

	var providerForCalled int32
	deps := CommandDeps{
		DataDir:     tmpDir,
		LoadBilling: func() BillingInfo { return BillingInfo{} },
		ProviderForOverride: func(name string, billing BillingInfo) Provider {
			atomic.AddInt32(&providerForCalled, 1)
			return fakeProvider{name: "kimi-coding", q: Quota{Provider: "kimi-coding", Used: Float64(200), Total: Float64(2000), FetchedAt: timeNow()}}
		},
	}

	code := Command(deps, []string{"refresh-provider", "kimi-coding"})
	if code == 0 {
		t.Fatal("expected nonzero exit code for dot-segment cache path alias")
	}

	// ProviderForOverride must never be called — the cache-path alias
	// check rejects the path before any fetch.
	if n := atomic.LoadInt32(&providerForCalled); n != 0 {
		t.Fatalf("expected 0 ProviderForOverride calls (alias rejected before fetch), got %d", n)
	}

	// No cache file should have been written at the canonical path.
	if _, err := os.Stat(canonicalCachePath); err == nil {
		t.Fatal("no cache file should exist at canonical path when dot-segment alias was rejected")
	}

	// Lock must be released.
	if _, err := os.Stat(lockPath); err == nil {
		t.Fatal("lockfile should have been released after dot-segment rejection")
	}
}

func TestQuotaRefreshProviderRejectsSymlinkParentAlias(t *testing.T) {
	tmpDir := t.TempDir()
	canonicalCachePath := filepath.Join(tmpDir, "quota", "kimi-coding.json")
	lockPath := canonicalCachePath + ".refresh.lock"

	lock, err := AcquireRefreshLock(lockPath)
	if err != nil {
		t.Fatal(err)
	}

	// Create a symlink in tmpDir pointing to a directory that is not
	// tmpDir, so that /link/../quota/ resolves to a parent of the
	// symlink target, not a parent of tmpDir.
	outsideDir := filepath.Join(tmpDir, "outside-target")
	if err := os.MkdirAll(outsideDir, 0o700); err != nil {
		t.Fatal(err)
	}
	symlinkPath := filepath.Join(tmpDir, "link-to-outside")
	if err := os.Symlink(outsideDir, symlinkPath); err != nil {
		t.Fatal(err)
	}

	// Construct the symlink-parent alias using raw string concat with
	// the platform separator — NOT filepath.Join/Clean. The literal ..
	// segment through a symlink resolves to a different filesystem
	// location than filepath.Clean would suggest.
	sep := string(os.PathSeparator)
	symAlias := symlinkPath + sep + ".." + sep + "quota" + sep + "kimi-coding.json"

	t.Setenv("FORGE_REFRESH_CACHE_PATH", symAlias)
	t.Setenv("FORGE_REFRESH_LOCK_PATH", lockPath)
	t.Setenv("FORGE_REFRESH_LOCK_TOKEN", lock.Token)

	var providerForCalled int32
	deps := CommandDeps{
		DataDir:     tmpDir,
		LoadBilling: func() BillingInfo { return BillingInfo{} },
		ProviderForOverride: func(name string, billing BillingInfo) Provider {
			atomic.AddInt32(&providerForCalled, 1)
			return fakeProvider{name: "kimi-coding", q: Quota{Provider: "kimi-coding", Used: Float64(200), Total: Float64(2000), FetchedAt: timeNow()}}
		},
	}

	code := Command(deps, []string{"refresh-provider", "kimi-coding"})
	if code == 0 {
		t.Fatal("expected nonzero exit code for symlink-parent cache path alias")
	}

	// ProviderForOverride must never be called — the cache-path alias
	// check rejects the path before any fetch.
	if n := atomic.LoadInt32(&providerForCalled); n != 0 {
		t.Fatalf("expected 0 ProviderForOverride calls (alias rejected before fetch), got %d", n)
	}

	// No cache file should have been written at the canonical path.
	if _, err := os.Stat(canonicalCachePath); err == nil {
		t.Fatal("no cache file should exist at canonical path when symlink alias was rejected")
	}

	// Lock must be released.
	if _, err := os.Stat(lockPath); err == nil {
		t.Fatal("lockfile should have been released after symlink alias rejection")
	}
}

// TestCachePathCanonicalContract verifies that poolCachePath produces the
// exact same cache filenames that existing readers depend on. Any mismatch
// here would mean refresh-provider validates a different path than the
// foreground cache reads, causing stale render or silent misbehavior.
func TestCachePathCanonicalContract(t *testing.T) {
	tests := []struct {
		pool string
		want string // expected relative path under <dataDir>/quota/
	}{
		{"codex", "codex.json"},
		{"codex-spark", "codex-spark.json"},
		{"kimi-coding", "kimi-coding.json"},
		{"zhipu-coding", "zhipu-coding.json"},
		{"anthropic", "anthropic.json"},
	}
	dataDir := "/some/data"
	for _, tc := range tests {
		t.Run(tc.pool, func(t *testing.T) {
			got := poolCachePath(dataDir, tc.pool)
			want := filepath.Join(dataDir, "quota", tc.want)
			if got != want {
				t.Fatalf("poolCachePath(%q) = %q, want %q", tc.pool, got, want)
			}
		})
	}
}

func TestQuotaListAllJSONWindowPreservation(t *testing.T) {
	tmpDir := t.TempDir()
	setFixedNow(t)
	now := fixedNow()

	// Seed a codex cache with a single 7d window (no fake 5h).
	cachePath := filepath.Join(tmpDir, "quota", "codex.json")
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o700); err != nil {
		t.Fatal(err)
	}
	cachedQ := Quota{
		Provider:  "codex",
		Source:    "codex-app-server",
		Used:      Float64(500),
		Total:     Float64(7000),
		FetchedAt: now,
		Windows:   []Window{{Name: "7d", Pct: 42, WindowMinutes: 10080}},
	}
	cacheData, _ := json.MarshalIndent(cacheEntry{Quota: cachedQ, FetchedAt: now}, "", "  ")
	if err := os.WriteFile(cachePath, cacheData, 0o600); err != nil {
		t.Fatal(err)
	}

	// Seed a kimi cache with 5h+7d+1mo windows.
	kimiPath := filepath.Join(tmpDir, "quota", "kimi-coding.json")
	kimiQ := Quota{
		Provider:  "kimi-coding",
		Used:      Float64(100),
		Total:     Float64(2048),
		FetchedAt: now,
		Windows: []Window{
			{Name: "5h", Pct: 50, WindowMinutes: 300},
			{Name: "7d", Pct: 10, WindowMinutes: 10080},
			{Name: "1mo", Pct: 72.5, WindowMinutes: 43200},
		},
	}
	kimiData, _ := json.MarshalIndent(cacheEntry{Quota: kimiQ, FetchedAt: now}, "", "  ")
	if err := os.WriteFile(kimiPath, kimiData, 0o600); err != nil {
		t.Fatal(err)
	}

	deps := CommandDeps{
		DataDir:              tmpDir,
		LoadConfig:           func() (ConfigInfo, []string, error) { return ConfigInfo{}, nil, nil },
		LoadBilling:          func() BillingInfo { return BillingInfo{DefaultQuotaTotal: 7000} },
		ResolveBigModelToken: func() string { return "" },
		ResolveKimiToken:     func() string { return "" },
		CodexBarEnabled:      func() bool { return false },
	}

	// Capture JSON output
	r, w, _ := os.Pipe()
	old := os.Stdout
	os.Stdout = w
	defer func() { os.Stdout = old }()

	code := quotaListAll(deps, BillingInfo{DefaultQuotaTotal: 7000}, true, false)
	w.Close()
	os.Stdout = old

	if code != 0 {
		t.Fatalf("expected exit code 0, got %d", code)
	}

	data, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}

	var entries []map[string]any
	if err := json.Unmarshal(data, &entries); err != nil {
		t.Fatalf("failed to parse JSON output: %v\nOutput: %s", err, string(data))
	}

	// Find codex entry — must have a single 7d window, no fake 5h.
	for _, e := range entries {
		pool, _ := e["pool"].(string)
		if pool == "codex" {
			windows, _ := e["windows"].([]any)
			if windows != nil && len(windows) == 2 {
				t.Fatalf("codex should not have 2 windows (no fake 5h): %#v", windows)
			}
			if windows != nil {
				w0 := windows[0].(map[string]any)
				if name, _ := w0["name"].(string); name != "7d" {
					t.Fatalf("codex window name = %q, want 7d", name)
				}
			}
			label, _ := e["label"].(string)
			if label != "codex" {
				t.Fatalf("codex label = %q, want codex", label)
			}
			// Pace must be a JSON object with delta_pct and text
			if pace, hasPace := e["pace"]; !hasPace {
				t.Fatal("codex requires pace (single 7d window)")
			} else {
				paceObj, ok := pace.(map[string]any)
				if !ok {
					t.Fatalf("codex pace should be an object, got %T: %#v", pace, pace)
				}
				if _, hasDP := paceObj["delta_pct"]; !hasDP {
					t.Fatal("codex pace missing delta_pct")
				}
				if text, hasText := paceObj["text"]; !hasText {
					t.Fatal("codex pace missing text")
				} else if _, ok := text.(string); !ok {
					t.Fatalf("codex pace text should be string, got %T", text)
				}
			}
			// Reset must be absent (no ResetsAt on windows)
			if _, hasReset := e["reset"]; hasReset {
				t.Fatal("codex should not have reset when no ResetsAt set")
			}
		}
		if pool == "kimi-coding" {
			label, _ := e["label"].(string)
			if label != "kimi" {
				t.Fatalf("kimi label = %q, want kimi", label)
			}
			windows, _ := e["windows"].([]any)
			if windows != nil && len(windows) != 3 {
				t.Fatalf("kimi should have 3 windows, got %d", len(windows))
			}
			// Pace must be a JSON object (7d anchor)
			if pace, hasPace := e["pace"]; !hasPace {
				t.Fatal("kimi requires pace (7d window present)")
			} else {
				paceObj, ok := pace.(map[string]any)
				if !ok {
					t.Fatalf("kimi pace should be an object, got %T: %#v", pace, pace)
				}
				if _, hasDP := paceObj["delta_pct"]; !hasDP {
					t.Fatal("kimi pace missing delta_pct")
				}
				if _, hasText := paceObj["text"]; !hasText {
					t.Fatal("kimi pace missing text")
				}
			}
		}
		if pool == "super-grok" {
			status, _ := e["status"].(string)
			if status != "unavailable" {
				t.Fatalf("super-grok status = %q, want unavailable", status)
			}
			errMsg, _ := e["error"].(string)
			if errMsg == "" {
				t.Fatal("super-grok should have an error message")
			}
			label, _ := e["label"].(string)
			if label != "super-grok" {
				t.Fatalf("super-grok label = %q, want super-grok", label)
			}
		}
	}
}

func TestQuotaListAllJSONLegacyCompat(t *testing.T) {
	tmpDir := t.TempDir()
	now := time.Now()

	cachePath := filepath.Join(tmpDir, "quota", "codex.json")
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o700); err != nil {
		t.Fatal(err)
	}
	cachedQ := Quota{
		Provider:  "codex",
		Source:    "codex-app-server",
		Used:      Float64(500),
		Total:     Float64(7000),
		FetchedAt: now,
	}
	cacheData, _ := json.MarshalIndent(cacheEntry{Quota: cachedQ, FetchedAt: now}, "", "  ")
	if err := os.WriteFile(cachePath, cacheData, 0o600); err != nil {
		t.Fatal(err)
	}

	deps := CommandDeps{
		DataDir:              tmpDir,
		LoadConfig:           func() (ConfigInfo, []string, error) { return ConfigInfo{}, nil, nil },
		LoadBilling:          func() BillingInfo { return BillingInfo{DefaultQuotaTotal: 7000} },
		ResolveBigModelToken: func() string { return "" },
		ResolveKimiToken:     func() string { return "" },
		CodexBarEnabled:      func() bool { return false },
	}

	r, w, _ := os.Pipe()
	old := os.Stdout
	os.Stdout = w

	code := quotaListAll(deps, BillingInfo{DefaultQuotaTotal: 7000}, true, false)
	w.Close()
	os.Stdout = old

	if code != 0 {
		t.Fatalf("expected exit code 0, got %d", code)
	}

	data, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}

	var entries []map[string]any
	if err := json.Unmarshal(data, &entries); err != nil {
		t.Fatalf("failed to parse JSON: %s", err)
	}

	for _, e := range entries {
		// Legacy fields must be present
		if _, hasPool := e["pool"]; !hasPool {
			t.Error("missing 'pool' field")
		}
		if _, hasStatus := e["status"]; !hasStatus {
			t.Error("missing 'status' field")
		}
	}
}

func TestCLIAliasResolution(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"codex", "codex"},
		{"codex-spark", "codex-spark"},
		{"spark", "codex-spark"},
		{"kimi-coding", "kimi-coding"},
		{"kimi", "kimi-coding"},
		{"zhipu-coding", "zhipu-coding"},
		{"glm", "zhipu-coding"},
		{"zai", "zhipu-coding"},
		{"anthropic", "anthropic"},
		{"super-grok", "super-grok"},
	}
	for _, tc := range tests {
		t.Run(tc.input, func(t *testing.T) {
			if got := canonicalName(tc.input); got != tc.want {
				t.Fatalf("canonicalName(%q) = %q, want %q", tc.input, got, tc.want)
			}
		})
	}
}

func TestCLIAliasRejectsUnknown(t *testing.T) {
	if got := canonicalName("unknown-pool"); got != "" {
		t.Fatalf("expected empty for unknown pool, got %q", got)
	}
	if got := canonicalName("grok"); got != "" {
		t.Fatalf("expected legacy grok to be rejected, got %q", got)
	}
}

func TestSuperGrokProviderUnavailable(t *testing.T) {
	deps := CommandDeps{
		LoadBilling: func() BillingInfo { return BillingInfo{} },
	}
	provider := innerProviderFor(deps, "super-grok", BillingInfo{})
	if provider != nil {
		t.Fatal("super-grok should have no provider (unavailable)")
	}
}

func TestQuotaShowOneJSONWithWindows(t *testing.T) {
	tmpDir := t.TempDir()
	setFixedNow(t)
	now := fixedNow()

	cachePath := filepath.Join(tmpDir, "quota", "zhipu-coding.json")
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o700); err != nil {
		t.Fatal(err)
	}
	q := Quota{
		Provider:  "zhipu-coding",
		Used:      Float64(300),
		Total:     Float64(1000),
		FetchedAt: now,
		Windows: []Window{
			{Name: "5h", Pct: 42, WindowMinutes: 300},
			{Name: "7d", Pct: 30, WindowMinutes: 10080},
		},
	}
	cacheData, _ := json.MarshalIndent(cacheEntry{Quota: q, FetchedAt: now}, "", "  ")
	if err := os.WriteFile(cachePath, cacheData, 0o600); err != nil {
		t.Fatal(err)
	}

	deps := CommandDeps{
		DataDir:              tmpDir,
		LoadConfig:           func() (ConfigInfo, []string, error) { return ConfigInfo{}, nil, nil },
		LoadBilling:          func() BillingInfo { return BillingInfo{DefaultQuotaTotal: 7000} },
		ResolveBigModelToken: func() string { return "" },
		ResolveKimiToken:     func() string { return "" },
		CodexBarEnabled:      func() bool { return false },
	}

	r, w, _ := os.Pipe()
	old := os.Stdout
	os.Stdout = w

	code := quotaShowOne(deps, "zhipu-coding", BillingInfo{DefaultQuotaTotal: 7000}, true, false)
	w.Close()
	os.Stdout = old

	if code != 0 {
		t.Fatalf("expected exit code 0, got %d", code)
	}

	data, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}

	var result map[string]any
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("failed to parse JSON: %s\nOutput: %s", err, string(data))
	}

	if pool, _ := result["pool"].(string); pool != "zhipu-coding" {
		t.Fatalf("pool = %q, want zhipu-coding", pool)
	}
	if label, _ := result["label"].(string); label != "glm" {
		t.Fatalf("label = %q, want glm", label)
	}
	used, _ := result["used"].(float64)
	if used != 300 {
		t.Fatalf("used = %f, want 300", used)
	}
	// Must have display_line
	dl, _ := result["display_line"].(string)
	if dl == "" {
		t.Fatal("expected non-empty display_line")
	}
	// Must have windows
	windows, _ := result["windows"].([]any)
	if len(windows) != 2 {
		t.Fatalf("expected 2 windows, got %d", len(windows))
	}
	// Must have fetched_at
	if _, hasFA := result["fetched_at"]; !hasFA {
		t.Fatal("missing fetched_at")
	}
	// Must have status
	status, _ := result["status"].(string)
	if status != "ok" {
		t.Fatalf("status = %q, want ok", status)
	}
	// Pace must be a JSON object with required fields (7d anchor)
	if pace, hasPace := result["pace"]; !hasPace {
		t.Fatal("expected pace in JSON output")
	} else {
		paceObj, ok := pace.(map[string]any)
		if !ok {
			t.Fatalf("pace should be a JSON object, got %T: %#v", pace, pace)
		}
		if _, hasDP := paceObj["delta_pct"]; !hasDP {
			t.Fatal("pace missing delta_pct field")
		}
		if text, hasText := paceObj["text"]; !hasText {
			t.Fatal("pace missing text field")
		} else if _, ok := text.(string); !ok {
			t.Fatalf("pace text should be string, got %T", text)
		}
	}
	// Reset must be absent (no ResetsAt on windows)
	if _, hasReset := result["reset"]; hasReset {
		t.Fatal("unexpected reset when windows have no ResetsAt")
	}
}

func TestQuotaShowOneJSONViaAlias(t *testing.T) {
	tmpDir := t.TempDir()
	now := time.Now()

	cachePath := filepath.Join(tmpDir, "quota", "kimi-coding.json")
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o700); err != nil {
		t.Fatal(err)
	}
	cachedQ := Quota{
		Provider:  "kimi-coding",
		Used:      Float64(100),
		Total:     Float64(2048),
		FetchedAt: now,
		Windows:   []Window{{Name: "5h", Pct: 50, WindowMinutes: 300}, {Name: "7d", Pct: 20, WindowMinutes: 10080}},
	}
	cacheData, _ := json.MarshalIndent(cacheEntry{Quota: cachedQ, FetchedAt: now}, "", "  ")
	if err := os.WriteFile(cachePath, cacheData, 0o600); err != nil {
		t.Fatal(err)
	}

	deps := CommandDeps{
		DataDir:              tmpDir,
		LoadConfig:           func() (ConfigInfo, []string, error) { return ConfigInfo{}, nil, nil },
		LoadBilling:          func() BillingInfo { return BillingInfo{DefaultQuotaTotal: 7000} },
		ResolveBigModelToken: func() string { return "" },
		ResolveKimiToken:     func() string { return "" },
		CodexBarEnabled:      func() bool { return false },
	}

	r, w, _ := os.Pipe()
	old := os.Stdout
	os.Stdout = w

	code := quotaShowOne(deps, "kimi", BillingInfo{DefaultQuotaTotal: 7000}, true, false)
	w.Close()
	os.Stdout = old

	if code != 0 {
		t.Fatalf("expected exit code 0, got %d", code)
	}

	data, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}

	var result map[string]any
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("failed to parse JSON: %s", err)
	}

	pool, _ := result["pool"].(string)
	if pool != "kimi-coding" {
		t.Fatalf("pool = %q, want kimi-coding (canonical), not alias 'kimi'", pool)
	}
	label, _ := result["label"].(string)
	if label != "kimi" {
		t.Fatalf("label = %q, want kimi", label)
	}
}

func TestQuotaShowOneSuperGrokReturnsUnavailable(t *testing.T) {
	deps := CommandDeps{
		DataDir:              t.TempDir(),
		LoadConfig:           func() (ConfigInfo, []string, error) { return ConfigInfo{}, nil, nil },
		LoadBilling:          func() BillingInfo { return BillingInfo{DefaultQuotaTotal: 7000} },
		ResolveBigModelToken: func() string { return "" },
		ResolveKimiToken:     func() string { return "" },
		CodexBarEnabled:      func() bool { return false },
	}

	r, w, _ := os.Pipe()
	old := os.Stdout
	os.Stdout = w

	code := quotaShowOne(deps, "super-grok", BillingInfo{DefaultQuotaTotal: 7000}, true, false)
	w.Close()
	os.Stdout = old

	if code != 0 {
		t.Fatalf("expected exit 0 for super-grok JSON unavailable, got %d", code)
	}

	var buf bytes.Buffer
	io.Copy(&buf, r)
	var result map[string]any
	if err := json.Unmarshal(buf.Bytes(), &result); err != nil {
		t.Fatalf("failed to parse JSON output: %v\nraw: %s", err, buf.String())
	}
	if result["pool"] != "super-grok" {
		t.Fatalf("expected pool=super-grok, got %v", result["pool"])
	}
	if result["label"] != "super-grok" {
		t.Fatalf("expected label=super-grok, got %v", result["label"])
	}
	if result["status"] != "unavailable" {
		t.Fatalf("expected status=unavailable, got %v", result["status"])
	}
	errMsg, _ := result["error"].(string)
	if errMsg == "" {
		t.Fatal("expected nonempty error message")
	}
}

func TestQuotaListAllJSONWithProviderError(t *testing.T) {
	tmpDir := t.TempDir()
	now := time.Now()

	cachePath := filepath.Join(tmpDir, "quota", "codex.json")
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o700); err != nil {
		t.Fatal(err)
	}
	cachedQ := Quota{
		Provider:  "codex",
		Used:      Float64(500),
		Total:     Float64(7000),
		FetchedAt: now.Add(-10 * time.Minute),
	}
	cacheData, _ := json.MarshalIndent(cacheEntry{Quota: cachedQ, FetchedAt: now.Add(-10 * time.Minute)}, "", "  ")
	if err := os.WriteFile(cachePath, cacheData, 0o600); err != nil {
		t.Fatal(err)
	}

	deps := CommandDeps{
		DataDir:              tmpDir,
		LoadConfig:           func() (ConfigInfo, []string, error) { return ConfigInfo{}, nil, nil },
		LoadBilling:          func() BillingInfo { return BillingInfo{DefaultQuotaTotal: 7000} },
		ResolveBigModelToken: func() string { return "" },
		ResolveKimiToken:     func() string { return "" },
		CodexBarEnabled:      func() bool { return true },
		ProviderForOverride: func(name string, billing BillingInfo) Provider {
			return fakeProvider{name: "codex", err: errors.New("simulated fetch error")}
		},
	}

	r, w, _ := os.Pipe()
	old := os.Stdout
	os.Stdout = w

	code := quotaListAll(deps, BillingInfo{DefaultQuotaTotal: 7000}, true, false)
	w.Close()
	os.Stdout = old

	if code != 0 {
		t.Fatalf("expected exit code 0, got %d", code)
	}

	data, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}

	var entries []map[string]any
	if err := json.Unmarshal(data, &entries); err != nil {
		t.Fatalf("failed to parse JSON: %s", err)
	}

	for _, e := range entries {
		pool, _ := e["pool"].(string)
		if pool == "codex" {
			status, _ := e["status"].(string)
			if status != "error" {
				t.Fatalf("codex status = %q, want error", status)
			}
			errMsg, _ := e["error"].(string)
			if !strings.Contains(errMsg, "simulated fetch error") {
				t.Fatalf("codex error = %q, want 'simulated fetch error'", errMsg)
			}
			if _, hasPool := e["pool"]; !hasPool {
				t.Error("missing pool field")
			}
			if _, hasStatus := e["status"]; !hasStatus {
				t.Error("missing status field")
			}
		}
	}
}

func TestSuperGrokListUnavailableEvenWithFreshCache(t *testing.T) {
	tmpDir := t.TempDir()
	setFixedNow(t)
	now := fixedNow()

	// Create a fresh cache for super-grok (as if it was fetched before
	// super-grok was removed from the provider catalog).
	cachePath := filepath.Join(tmpDir, "quota", "super-grok.json")
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o700); err != nil {
		t.Fatal(err)
	}
	cachedQ := Quota{
		Provider:  "super-grok",
		Used:      Float64(100),
		Total:     Float64(1000),
		FetchedAt: now,
	}
	cacheData, _ := json.MarshalIndent(cacheEntry{Quota: cachedQ, FetchedAt: now}, "", "  ")
	if err := os.WriteFile(cachePath, cacheData, 0o600); err != nil {
		t.Fatal(err)
	}

	deps := CommandDeps{
		DataDir:              tmpDir,
		LoadConfig:           func() (ConfigInfo, []string, error) { return ConfigInfo{}, nil, nil },
		LoadBilling:          func() BillingInfo { return BillingInfo{DefaultQuotaTotal: 7000} },
		ResolveBigModelToken: func() string { return "" },
		ResolveKimiToken:     func() string { return "" },
		CodexBarEnabled:      func() bool { return false },
	}

	r, w, _ := os.Pipe()
	old := os.Stdout
	os.Stdout = w

	code := quotaListAll(deps, BillingInfo{DefaultQuotaTotal: 7000}, true, false)
	w.Close()
	os.Stdout = old

	if code != 0 {
		t.Fatalf("expected exit code 0, got %d", code)
	}

	data, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}

	var entries []map[string]any
	if err := json.Unmarshal(data, &entries); err != nil {
		t.Fatalf("failed to parse JSON output: %v\nOutput: %s", err, string(data))
	}

	for _, e := range entries {
		pool, _ := e["pool"].(string)
		if pool == "super-grok" {
			status, _ := e["status"].(string)
			if status != "unavailable" {
				t.Fatalf("super-grok status = %q, want unavailable even with fresh cache", status)
			}
			errMsg, _ := e["error"].(string)
			if errMsg == "" {
				t.Fatal("super-grok should have error message when unavailable")
			}
			// Must NOT contain cached fields like used, total, windows.
			if _, hasUsed := e["used"]; hasUsed {
				t.Fatal("super-grok should not emit used when unavailable")
			}
		}
	}
}

func TestListCacheHitCopiesStale(t *testing.T) {
	tmpDir := t.TempDir()
	setFixedNow(t)
	now := fixedNow()

	cachePath := filepath.Join(tmpDir, "quota", "codex.json")
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o700); err != nil {
		t.Fatal(err)
	}
	cachedQ := Quota{
		Provider:  "codex",
		Source:    "codex-app-server",
		Used:      Float64(500),
		Total:     Float64(7000),
		FetchedAt: now,
		Stale:     true,
		Windows:   []Window{{Name: "7d", Pct: 42, WindowMinutes: 10080}},
	}
	cacheData, _ := json.MarshalIndent(cacheEntry{Quota: cachedQ, FetchedAt: now}, "", "  ")
	if err := os.WriteFile(cachePath, cacheData, 0o600); err != nil {
		t.Fatal(err)
	}

	deps := CommandDeps{
		DataDir:              tmpDir,
		LoadConfig:           func() (ConfigInfo, []string, error) { return ConfigInfo{}, nil, nil },
		LoadBilling:          func() BillingInfo { return BillingInfo{DefaultQuotaTotal: 7000} },
		ResolveBigModelToken: func() string { return "" },
		ResolveKimiToken:     func() string { return "" },
		CodexBarEnabled:      func() bool { return false },
	}

	r, w, _ := os.Pipe()
	old := os.Stdout
	os.Stdout = w

	code := quotaListAll(deps, BillingInfo{DefaultQuotaTotal: 7000}, true, false)
	w.Close()
	os.Stdout = old

	if code != 0 {
		t.Fatalf("expected exit code 0, got %d", code)
	}

	data, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}

	var entries []map[string]any
	if err := json.Unmarshal(data, &entries); err != nil {
		t.Fatalf("failed to parse JSON: %s", err)
	}

	for _, e := range entries {
		pool, _ := e["pool"].(string)
		if pool == "codex" {
			stale, _ := e["stale"].(bool)
			if !stale {
				t.Fatal("cache hit should copy Stale=true from cached entry")
			}
		}
	}
}

func TestSingleJSONRetainsZeroUsedTotal(t *testing.T) {
	tmpDir := t.TempDir()
	setFixedNow(t)
	now := fixedNow()

	cachePath := filepath.Join(tmpDir, "quota", "codex.json")
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o700); err != nil {
		t.Fatal(err)
	}
	// Cache hit with zero used/total.
	cachedQ := Quota{
		Provider:  "codex",
		Source:    "codex-app-server",
		Used:      Float64(0),
		Total:     Float64(0),
		FetchedAt: now,
	}
	cacheData, _ := json.MarshalIndent(cacheEntry{Quota: cachedQ, FetchedAt: now}, "", "  ")
	if err := os.WriteFile(cachePath, cacheData, 0o600); err != nil {
		t.Fatal(err)
	}

	deps := CommandDeps{
		DataDir:              tmpDir,
		LoadConfig:           func() (ConfigInfo, []string, error) { return ConfigInfo{}, nil, nil },
		LoadBilling:          func() BillingInfo { return BillingInfo{DefaultQuotaTotal: 7000} },
		ResolveBigModelToken: func() string { return "" },
		ResolveKimiToken:     func() string { return "" },
		CodexBarEnabled:      func() bool { return false },
	}

	r, w, _ := os.Pipe()
	old := os.Stdout
	os.Stdout = w

	code := quotaShowOne(deps, "codex", BillingInfo{DefaultQuotaTotal: 7000}, true, false)
	w.Close()
	os.Stdout = old

	if code != 0 {
		t.Fatalf("expected exit code 0, got %d", code)
	}

	data, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}

	var result map[string]any
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("failed to parse JSON: %s\nOutput: %s", err, string(data))
	}

	// used and total must be present even when zero.
	used, hasUsed := result["used"].(float64)
	if !hasUsed {
		t.Fatal("single JSON must include 'used' field even at zero")
	}
	if used != 0 {
		t.Fatalf("used = %f, want 0", used)
	}
	total, hasTotal := result["total"].(float64)
	if !hasTotal {
		t.Fatal("single JSON must include 'total' field even at zero")
	}
	if total != 0 {
		t.Fatalf("total = %f, want 0", total)
	}
}

func TestQuotaListAllJSONZeroUsedTotal(t *testing.T) {
	tmpDir := t.TempDir()
	setFixedNow(t)
	now := fixedNow()

	cachePath := filepath.Join(tmpDir, "quota", "codex.json")
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o700); err != nil {
		t.Fatal(err)
	}
	// Cache hit with zero used/total — both must serialize as 0.
	cachedQ := Quota{
		Provider:  "codex",
		Source:    "codex-app-server",
		Used:      Float64(0),
		Total:     Float64(0),
		FetchedAt: now,
	}
	cacheData, _ := json.MarshalIndent(cacheEntry{Quota: cachedQ, FetchedAt: now}, "", "  ")
	if err := os.WriteFile(cachePath, cacheData, 0o600); err != nil {
		t.Fatal(err)
	}

	deps := CommandDeps{
		DataDir:              tmpDir,
		LoadConfig:           func() (ConfigInfo, []string, error) { return ConfigInfo{}, nil, nil },
		LoadBilling:          func() BillingInfo { return BillingInfo{DefaultQuotaTotal: 7000} },
		ResolveBigModelToken: func() string { return "" },
		ResolveKimiToken:     func() string { return "" },
		CodexBarEnabled:      func() bool { return false },
	}

	r, w, _ := os.Pipe()
	old := os.Stdout
	os.Stdout = w

	code := quotaListAll(deps, BillingInfo{DefaultQuotaTotal: 7000}, true, false)
	w.Close()
	os.Stdout = old

	if code != 0 {
		t.Fatalf("expected exit code 0, got %d", code)
	}

	data, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}

	var entries []map[string]any
	if err := json.Unmarshal(data, &entries); err != nil {
		t.Fatalf("failed to parse JSON: %s\nOutput: %s", err, string(data))
	}

	for _, e := range entries {
		pool, _ := e["pool"].(string)
		if pool == "codex" {
			used, hasUsed := e["used"].(float64)
			if !hasUsed {
				t.Fatal("list JSON must include 'used' field even at zero")
			}
			if used != 0 {
				t.Fatalf("used = %f, want 0", used)
			}
			total, hasTotal := e["total"].(float64)
			if !hasTotal {
				t.Fatal("list JSON must include 'total' field even at zero")
			}
			if total != 0 {
				t.Fatalf("total = %f, want 0", total)
			}
		}
	}
}

func TestQuotaShowOneJSONCachedFromCache(t *testing.T) {
	tmpDir := t.TempDir()
	setFixedNow(t)
	now := fixedNow()

	cachePath := filepath.Join(tmpDir, "quota", "codex.json")
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o700); err != nil {
		t.Fatal(err)
	}
	cachedQ := Quota{
		Provider:  "codex",
		Source:    "codex-app-server",
		Used:      Float64(500),
		Total:     Float64(7000),
		FetchedAt: now,
	}
	cacheData, _ := json.MarshalIndent(cacheEntry{Quota: cachedQ, FetchedAt: now}, "", "  ")
	if err := os.WriteFile(cachePath, cacheData, 0o600); err != nil {
		t.Fatal(err)
	}

	deps := CommandDeps{
		DataDir:              tmpDir,
		LoadConfig:           func() (ConfigInfo, []string, error) { return ConfigInfo{}, nil, nil },
		LoadBilling:          func() BillingInfo { return BillingInfo{DefaultQuotaTotal: 7000} },
		ResolveBigModelToken: func() string { return "" },
		ResolveKimiToken:     func() string { return "" },
		CodexBarEnabled:      func() bool { return false },
	}

	r, w, _ := os.Pipe()
	old := os.Stdout
	os.Stdout = w

	code := quotaShowOne(deps, "codex", BillingInfo{DefaultQuotaTotal: 7000}, true, false)
	w.Close()
	os.Stdout = old

	if code != 0 {
		t.Fatalf("expected exit code 0, got %d", code)
	}

	data, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}

	var result map[string]any
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("failed to parse JSON: %s\nOutput: %s", err, string(data))
	}

	// Legacy "from":"cache" field must be present alongside structured fields.
	from, hasFrom := result["from"]
	if !hasFrom {
		t.Fatal("cached single JSON must include 'from' field")
	}
	fromStr, ok := from.(string)
	if !ok || fromStr != "cache" {
		t.Fatalf("from = %v (type %T), want \"cache\"", from, from)
	}

	// Existing "source":"cache" may also remain.
	source, hasSource := result["source"]
	if !hasSource {
		t.Fatal("cached single JSON should still include 'source' field")
	}
	if src, _ := source.(string); src != "cache" {
		t.Fatalf("source = %q, want \"cache\"", src)
	}

	// Structured fields must still be present.
	if _, hasUsed := result["used"]; !hasUsed {
		t.Fatal("missing 'used' field")
	}
	if _, hasTotal := result["total"]; !hasTotal {
		t.Fatal("missing 'total' field")
	}
}

func TestQuotaShowOneJSONAddsRemainingMarkersForActualWindows(t *testing.T) {
	tmpDir := t.TempDir()
	setFixedNow(t)
	now := fixedNow()
	reset := now.Add(150 * time.Minute)

	cachePath := filepath.Join(tmpDir, "quota", "zhipu-coding.json")
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o700); err != nil {
		t.Fatal(err)
	}
	q := Quota{
		Provider:  "zhipu-coding",
		Used:      Float64(300),
		Total:     Float64(1000),
		FetchedAt: now,
		Windows: []Window{
			{Name: "5h", Pct: 125, ResetsAt: &reset, WindowMinutes: 300},
			{Name: "7d", Pct: -5, WindowMinutes: 10080},
			{Name: "1h", Pct: 40},
		},
	}
	cacheData, err := json.MarshalIndent(cacheEntry{Quota: q, FetchedAt: now}, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cachePath, cacheData, 0o600); err != nil {
		t.Fatal(err)
	}

	result, code := captureQuotaShowOneJSON(t, testQuotaCommandDeps(tmpDir), "zhipu-coding")
	if code != 0 {
		t.Fatalf("quotaShowOne exit code = %d, want 0", code)
	}

	windows, ok := result["windows"].([]any)
	if !ok || len(windows) != 3 {
		t.Fatalf("windows = %#v, want exactly the three provider windows", result["windows"])
	}
	byName := make(map[string]map[string]any, len(windows))
	for _, raw := range windows {
		window, ok := raw.(map[string]any)
		if !ok {
			t.Fatalf("window = %T, want object", raw)
		}
		byName[window["name"].(string)] = window
	}

	assertJSONFloat(t, byName["5h"], "remaining_pct", 0)
	assertJSONFloat(t, byName["5h"], "expected_remaining_pct", 50)
	assertJSONFloat(t, byName["7d"], "remaining_pct", 100)
	assertJSONFloat(t, byName["7d"], "expected_remaining_pct", 100-(float64(2*24+10)/float64(7*24))*100)
	if got, ok := byName["1h"]["expected_remaining_pct"]; !ok || got != nil {
		t.Fatalf("unavailable 1h expected_remaining_pct = %#v, want null", got)
	}
	assertJSONFloat(t, byName["1h"], "remaining_pct", 60)
}

func TestQuotaWindowJSONDSTFallbackPreservesLegacyPaceAndClampsMarker(t *testing.T) {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatalf("load America/New_York: %v", err)
	}
	now := time.Date(2024, time.November, 3, 23, 30, 0, 0, loc)
	oldNow := timeNow
	timeNow = func() time.Time { return now }
	t.Cleanup(func() { timeNow = oldNow })

	window := Window{Name: "7d", Pct: 50.6}
	weekStart := time.Date(2024, time.October, 28, 0, 0, 0, 0, loc)
	expectedUsed := now.Sub(weekStart).Seconds() / (7 * 24 * 3600) * 100
	if expectedUsed <= 100 {
		t.Fatalf("fall-back fixture expected used = %f, want >100", expectedUsed)
	}
	wantDelta := window.Pct - expectedUsed
	if got := WindowPaceDeltaAt(window, now); math.Abs(got-wantDelta) > 1e-9 {
		t.Fatalf("legacy WindowPaceDeltaAt = %.12f, want %.12f", got, wantDelta)
	}

	line := DisplayLine(Quota{Windows: []Window{window}})
	if want := "7d 51% " + FormatPaceDisplay(wantDelta); !strings.Contains(line, want) {
		t.Fatalf("display_line = %q, want legacy pace %q", line, want)
	}

	projected := quotaWindowsJSON([]Window{window})
	if len(projected) != 1 || projected[0].ExpectedRemainingPct == nil {
		t.Fatalf("projected windows = %#v, want expected remaining marker", projected)
	}
	if got := *projected[0].ExpectedRemainingPct; got < 0 || got > 100 {
		t.Fatalf("expected_remaining_pct = %f, want 0..100", got)
	}
	if got := *projected[0].ExpectedRemainingPct; got != 0 {
		t.Fatalf("expected_remaining_pct = %f, want clamp to 0 at JSON boundary", got)
	}
}

func testQuotaCommandDeps(dataDir string) CommandDeps {
	return CommandDeps{
		DataDir:              dataDir,
		LoadConfig:           func() (ConfigInfo, []string, error) { return ConfigInfo{}, nil, nil },
		LoadBilling:          func() BillingInfo { return BillingInfo{DefaultQuotaTotal: 7000} },
		ResolveBigModelToken: func() string { return "" },
		ResolveKimiToken:     func() string { return "" },
		CodexBarEnabled:      func() bool { return false },
	}
}

func captureQuotaShowOneJSON(t *testing.T, deps CommandDeps, name string) (map[string]any, int) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	old := os.Stdout
	os.Stdout = w
	code := quotaShowOne(deps, name, deps.LoadBilling(), true, false)
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	os.Stdout = old
	data, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	var result map[string]any
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("parse quota JSON: %v\noutput: %s", err, data)
	}
	return result, code
}

func assertJSONFloat(t *testing.T, value map[string]any, field string, want float64) {
	t.Helper()
	got, ok := value[field].(float64)
	if !ok {
		t.Fatalf("%s = %#v, want number", field, value[field])
	}
	if math.Abs(got-want) > 1e-9 {
		t.Fatalf("%s = %.12f, want %.12f", field, got, want)
	}
}

// --- Hard-TTL (fail-closed) regression tests ---

func TestCachedProviderFailClosedFreshCacheHit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")
	now := timeNow()
	fresh := Quota{Provider: "codex", Windows: []Window{{Name: "5h", Pct: 12, WindowMinutes: 300}}, FetchedAt: now}
	if err := writeCache(path, fresh); err != nil {
		t.Fatal(err)
	}

	// Inner would be called on cache miss or TTL expiry.
	fetchCalled := false
	inner := fakeProvider{
		name: "codex",
		err:  errors.New("should not be called"),
	}

	p := &CachedProvider{
		Inner:      inner,
		Path:       path,
		TTL:        10 * time.Minute,
		FailClosed: true,
	}

	q, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(q.Windows) == 0 || q.Windows[0].Pct != 12 {
		t.Fatalf("expected cached windows with Pct=12, got %#v", q.Windows)
	}
	if fetchCalled {
		t.Fatal("inner fetch should not be called on fresh cache hit")
	}
}

func TestCachedProviderFailClosedTTLExpiredFetchSuccess(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")
	old := timeNow().Add(-2 * time.Minute)
	oldQ := Quota{Provider: "codex", Windows: []Window{{Name: "5h", Pct: 12, WindowMinutes: 300}}, FetchedAt: old}
	if err := writeCache(path, oldQ); err != nil {
		t.Fatal(err)
	}

	p := &CachedProvider{
		Inner: fakeProvider{
			name: "codex",
			q:    Quota{Provider: "codex", Windows: []Window{{Name: "5h", Pct: 99, WindowMinutes: 300}}, FetchedAt: timeNow()},
		},
		Path:       path,
		TTL:        60 * time.Second, // cache is 2min old, past 60s TTL
		FailClosed: true,
	}

	q, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(q.Windows) == 0 || q.Windows[0].Pct != 99 {
		t.Fatalf("expected refreshed windows with Pct=99, got %#v", q.Windows)
	}
}

func TestCachedProviderFailClosedTTLExpiredAPIFailureReturnsError(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")
	old := timeNow().Add(-2 * time.Minute)
	oldQ := Quota{Provider: "codex", Windows: []Window{{Name: "5h", Pct: 12, WindowMinutes: 300}}, FetchedAt: old}
	if err := writeCache(path, oldQ); err != nil {
		t.Fatal(err)
	}

	p := &CachedProvider{
		Inner: fakeProvider{
			name: "codex",
			err:  errors.New("API failure"),
		},
		Path:       path,
		TTL:        60 * time.Second, // cache is 2min old, past 60s TTL
		FailClosed: true,
	}

	_, err := p.Fetch(context.Background())
	if err == nil || !strings.Contains(err.Error(), "API failure") {
		t.Fatalf("expected 'API failure' error, got %v", err)
	}

	// Verify cache now contains a failure marker, not stale data.
	e, ok := readCache(path)
	if !ok || e.FailedAt.IsZero() {
		t.Fatal("expected failure marker in cache after fail-closed fetch error")
	}

	// Ensure the old quota was replaced by the failure marker.
	if e.Quota.Windows != nil || e.FetchedAt.Equal(old) {
		t.Fatal("old quota should not be preserved after fail-closed failure")
	}
}

func TestCachedProviderFailClosedNeverReportsStale(t *testing.T) {
	// Verify that with FailClosed=true, the returned Quota never has Stale=true.
	path := filepath.Join(t.TempDir(), "quota.json")
	old := timeNow().Add(-2 * time.Minute)
	oldQ := Quota{Provider: "codex", Windows: []Window{{Name: "5h", Pct: 12, WindowMinutes: 300}}, FetchedAt: old}
	if err := writeCache(path, oldQ); err != nil {
		t.Fatal(err)
	}

	p := &CachedProvider{
		Inner: fakeProvider{
			name: "codex",
			q:    Quota{Provider: "codex", Windows: []Window{{Name: "5h", Pct: 99, WindowMinutes: 300}}, FetchedAt: timeNow()},
		},
		Path:       path,
		TTL:        60 * time.Second,
		FailClosed: true,
	}

	q, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if q.Stale {
		t.Fatal("fail-closed cache must never return stale=true")
	}
}

func TestCachedProviderFailClosedCodexSparkTTLExpired(t *testing.T) {
	path := filepath.Join(t.TempDir(), "spark-quota.json")
	old := timeNow().Add(-2 * time.Minute)
	oldQ := Quota{Provider: "codex-spark", Windows: []Window{{Name: "5h", Pct: 30, WindowMinutes: 300}}, FetchedAt: old}
	if err := writeCache(path, oldQ); err != nil {
		t.Fatal(err)
	}

	p := &CachedProvider{
		Inner: fakeProvider{
			name: "codex-spark",
			q:    Quota{Provider: "codex-spark", Windows: []Window{{Name: "5h", Pct: 60, WindowMinutes: 300}}, FetchedAt: timeNow()},
		},
		Path:       path,
		TTL:        60 * time.Second,
		FailClosed: true,
	}

	q, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(q.Windows) == 0 || q.Windows[0].Pct != 60 {
		t.Fatalf("expected refreshed windows with Pct=60, got %#v", q.Windows)
	}
	if q.Stale {
		t.Fatal("codex-spark fail-closed must never return stale=true")
	}
}

func TestCachedProviderFailClosedCodexSparkAPIFailureReturnsError(t *testing.T) {
	path := filepath.Join(t.TempDir(), "spark-quota.json")
	old := timeNow().Add(-2 * time.Minute)
	oldQ := Quota{Provider: "codex-spark", Windows: []Window{{Name: "5h", Pct: 30, WindowMinutes: 300}}, FetchedAt: old}
	if err := writeCache(path, oldQ); err != nil {
		t.Fatal(err)
	}

	p := &CachedProvider{
		Inner: fakeProvider{
			name: "codex-spark",
			err:  errors.New("spark API failure"),
		},
		Path:       path,
		TTL:        60 * time.Second,
		FailClosed: true,
	}

	_, err := p.Fetch(context.Background())
	if err == nil || !strings.Contains(err.Error(), "spark API failure") {
		t.Fatalf("expected 'spark API failure' error, got %v", err)
	}
}

func TestCachedProviderFailClosedDetachedRefreshReplacesStaleWithFailureMarker(t *testing.T) {
	path := filepath.Join(t.TempDir(), "codex-quota.json")
	old := timeNow().Add(-2 * time.Minute)
	oldQ := Quota{Provider: "codex", Windows: []Window{{Name: "5h", Pct: 12, WindowMinutes: 300}}, FetchedAt: old}
	if err := writeCache(path, oldQ); err != nil {
		t.Fatal(err)
	}

	// Simulate detached refresh (handleRefreshProvider) failure by
	// calling writeRefreshFailureForce directly.
	if err := writeRefreshFailureForce(path, time.Now(), "API failure"); err != nil {
		t.Fatal(err)
	}

	// Cache must now contain a failure marker, not the old quota.
	e, ok := readCache(path)
	if !ok || e.FailedAt.IsZero() {
		t.Fatal("expected failure marker after fail-closed detached refresh failure")
	}
	if e.Quota.Windows != nil {
		t.Fatal("old quota should be replaced by failure marker, not preserved")
	}
}

// --- FailClosed + SWROnly hard-TTL tests ---

func TestCachedProviderFailClosedSWROnlyFreshCacheHit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")
	now := timeNow()
	fresh := Quota{Provider: "codex", Windows: []Window{{Name: "5h", Pct: 12, WindowMinutes: 300}}, FetchedAt: now}
	if err := writeCache(path, fresh); err != nil {
		t.Fatal(err)
	}

	p := &CachedProvider{
		Inner:      fetchIsFatal{t: t},
		Path:       path,
		TTL:        10 * time.Minute,
		SWROnly:    true,
		FailClosed: true,
		Spawner:    &NoopSpawner{},
	}

	q, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(q.Windows) == 0 || q.Windows[0].Pct != 12 {
		t.Fatalf("expected cached windows with Pct=12, got %#v", q.Windows)
	}
	if q.Stale {
		t.Fatal("fresh fail-closed SWROnly cache must not be stale")
	}
}

func TestCachedProviderFailClosedSWROnlyExpiredReturnsError(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")
	old := timeNow().Add(-5 * time.Minute)
	oldQ := Quota{Provider: "codex", Windows: []Window{{Name: "5h", Pct: 12, WindowMinutes: 300}}, FetchedAt: old}
	if err := writeCache(path, oldQ); err != nil {
		t.Fatal(err)
	}

	noop := &NoopSpawner{}
	p := &CachedProvider{
		Inner:      fetchIsFatal{t: t},
		Path:       path,
		TTL:        60 * time.Second, // cache is 5min old, past 60s TTL
		SWROnly:    true,
		FailClosed: true,
		Spawner:    noop,
	}

	_, err := p.Fetch(context.Background())
	if err == nil || !strings.Contains(err.Error(), "quota expired") {
		t.Fatalf("expected 'quota expired' error, got %v", err)
	}

	// Must have kicked a background refresh.
	if noop.Calls != 1 {
		t.Fatalf("expected 1 background refresh kick, got %d", noop.Calls)
	}
}

func TestCachedProviderFailClosedSWROnlyNoCacheReturnsError(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")
	// No cache file exists.

	noop := &NoopSpawner{}
	p := &CachedProvider{
		Inner:      fetchIsFatal{t: t},
		Path:       path,
		TTL:        60 * time.Second,
		SWROnly:    true,
		FailClosed: true,
		Spawner:    noop,
	}

	_, err := p.Fetch(context.Background())
	if err == nil || !strings.Contains(err.Error(), "unavailable") {
		t.Fatalf("expected 'unavailable' error, got %v", err)
	}

	// Must have kicked a background refresh.
	if noop.Calls != 1 {
		t.Fatalf("expected 1 background refresh kick, got %d", noop.Calls)
	}
}

func TestCachedProviderFailClosedSWROnlyFailureMarkerReturnsError(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")

	// Write a failure marker (FailedAt set, no FetchedAt/Quota).
	if err := writeFailureMarker(path, timeNow(), "provider error: rate limit exceeded"); err != nil {
		t.Fatal(err)
	}

	p := &CachedProvider{
		Inner:      fetchIsFatal{t: t},
		Path:       path,
		TTL:        10 * time.Minute,
		SWROnly:    true,
		FailClosed: true,
		Spawner:    &NoopSpawner{},
	}

	_, err := p.Fetch(context.Background())
	if err == nil || !strings.Contains(err.Error(), "rate limit exceeded") {
		t.Fatalf("expected failure marker error, got %v", err)
	}
}

// --- FailClosed + SWROnly failure-marker expiry regression tests ---

func TestCachedProviderFailClosedSWROnlyExpiredFailureMarkerKicksRefresh(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")

	// Write an expired failure marker (2 minutes old, failureTTL capped at 60s).
	// Seed LastAttemptAt to verify the throttle bypass — without it the recent
	// stamp would suppress the spawn for the full RefreshAge (10m).
	old := time.Now().Add(-2 * time.Minute)
	entry := cacheEntry{FailedAt: old, Error: "old error", LastAttemptAt: time.Now()}
	raw, _ := json.MarshalIndent(entry, "", "  ")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}

	noop := &NoopSpawner{}
	p := &CachedProvider{
		Inner:      fetchIsFatal{t: t},
		Path:       path,
		TTL:        10 * time.Minute,
		RefreshAge: 10 * time.Minute,
		SWROnly:    true,
		FailClosed: true,
		Spawner:    noop,
	}

	_, err := p.Fetch(context.Background())
	if err == nil || !strings.Contains(err.Error(), "refresh started") {
		t.Fatalf("expected 'refresh started' error for expired failure marker, got %v", err)
	}

	// Must have kicked a background refresh.
	if noop.Calls != 1 {
		t.Fatalf("expected 1 background refresh kick for expired failure marker, got %d", noop.Calls)
	}
}

func TestCachedProviderFailClosedSWROnlyFutureDatedFailureMarkerKicksRefresh(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")

	// Write a future-dated failure marker (10 minutes in the future).
	// Seed LastAttemptAt to verify the throttle bypass — without it the recent
	// stamp would suppress the spawn for the full RefreshAge (10m).
	future := time.Now().Add(10 * time.Minute)
	entry := cacheEntry{FailedAt: future, Error: "future error", LastAttemptAt: time.Now()}
	raw, _ := json.MarshalIndent(entry, "", "  ")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}

	noop := &NoopSpawner{}
	p := &CachedProvider{
		Inner:      fetchIsFatal{t: t},
		Path:       path,
		TTL:        10 * time.Minute,
		RefreshAge: 10 * time.Minute,
		SWROnly:    true,
		FailClosed: true,
		Spawner:    noop,
	}

	_, err := p.Fetch(context.Background())
	if err == nil || !strings.Contains(err.Error(), "refresh started") {
		t.Fatalf("expected 'refresh started' error for future-dated failure marker, got %v", err)
	}

	// Must have kicked a background refresh.
	if noop.Calls != 1 {
		t.Fatalf("expected 1 background refresh kick for future-dated failure marker, got %d", noop.Calls)
	}
}

func TestCachedProviderFailClosedNormalModeExpiredFutureDatedFailureMarkerCallsInner(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")

	// Write an expired failure marker (2 minutes old, TTL 60s → failureTTL 60s).
	old := time.Now().Add(-2 * time.Minute)
	entry := cacheEntry{FailedAt: old, Error: "stale error"}
	raw, _ := json.MarshalIndent(entry, "", "  ")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}

	inner := fakeProvider{
		name: "test",
		q:    Quota{Provider: "test", Used: Float64(42), Total: Float64(100), FetchedAt: time.Now()},
	}

	p := &CachedProvider{
		Inner:      inner,
		Path:       path,
		TTL:        60 * time.Second,
		FailClosed: true,
	}

	q, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatalf("expected successful Fetch via Inner for expired failure marker, got %v", err)
	}
	if q.Used == nil || *q.Used != 42 {
		t.Fatalf("expected used=42 from Inner, got %#v", q.Used)
	}
}

func TestCachedProviderFailClosedNormalModeFutureDatedFailureMarkerCallsInner(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")

	// Write a future-dated failure marker (10 minutes ahead).
	future := time.Now().Add(10 * time.Minute)
	entry := cacheEntry{FailedAt: future, Error: "future error"}
	raw, _ := json.MarshalIndent(entry, "", "  ")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}

	inner := fakeProvider{
		name: "test",
		q:    Quota{Provider: "test", Used: Float64(99), Total: Float64(200), FetchedAt: time.Now()},
	}

	p := &CachedProvider{
		Inner:      inner,
		Path:       path,
		TTL:        60 * time.Second,
		FailClosed: true,
	}

	q, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatalf("expected successful Fetch via Inner for future-dated failure marker, got %v", err)
	}
	if q.Used == nil || *q.Used != 99 {
		t.Fatalf("expected used=99 from Inner, got %#v", q.Used)
	}
}

func TestQuotaShowOneCodexForegroundFetchErrorReplacesCache(t *testing.T) {
	tmpDir := t.TempDir()
	setFixedNow(t)
	now := fixedNow()

	// Seed a valid correct-source codex cache.
	cachePath := filepath.Join(tmpDir, "quota", "codex.json")
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o700); err != nil {
		t.Fatal(err)
	}
	cachedQ := Quota{
		Provider:  "codex",
		Source:    "codex-app-server",
		Used:      Float64(500),
		Total:     Float64(7000),
		FetchedAt: now,
	}
	cacheData, _ := json.MarshalIndent(cacheEntry{Quota: cachedQ, FetchedAt: now}, "", "  ")
	if err := os.WriteFile(cachePath, cacheData, 0o600); err != nil {
		t.Fatal(err)
	}

	// Provider returns an error to simulate foreground fetch failure.
	deps := testQuotaCommandDeps(tmpDir)
	deps.ProviderForOverride = func(name string, billing BillingInfo) Provider {
		return fakeProvider{name: "codex", err: errors.New("simulated codex error")}
	}

	r, w, _ := os.Pipe()
	old := os.Stdout
	os.Stdout = w

	code := quotaShowOne(deps, "codex", BillingInfo{DefaultQuotaTotal: 7000}, true, true)
	w.Close()
	os.Stdout = old
	_ = r

	if code != 0 {
		t.Fatalf("expected exit code 0 for JSON error output, got %d", code)
	}

	// Cache must now contain a failure marker, not the original valid quota.
	e, ok := readCache(cachePath)
	if !ok || e.FailedAt.IsZero() {
		t.Fatal("expected failure marker in cache after codex foreground fetch error")
	}
	if e.Quota.Source == "codex-app-server" && e.Quota.Used != nil && *e.Quota.Used == 500 {
		t.Fatal("original valid quota should be replaced by failure marker, not preserved")
	}
	if !strings.Contains(e.Error, "simulated codex error") {
		t.Fatalf("failure marker error = %q, want 'simulated codex error'", e.Error)
	}
}

func TestQuotaListAllCodexSparkForegroundFetchErrorReplacesCache(t *testing.T) {
	tmpDir := t.TempDir()
	setFixedNow(t)
	now := fixedNow()

	// Seed a valid correct-source codex-spark cache.
	cachePath := filepath.Join(tmpDir, "quota", "codex-spark.json")
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o700); err != nil {
		t.Fatal(err)
	}
	cachedQ := Quota{
		Provider:  "codex-spark",
		Source:    "codex-app-server",
		Used:      Float64(100),
		Total:     Float64(2000),
		FetchedAt: now,
	}
	cacheData, _ := json.MarshalIndent(cacheEntry{Quota: cachedQ, FetchedAt: now}, "", "  ")
	if err := os.WriteFile(cachePath, cacheData, 0o600); err != nil {
		t.Fatal(err)
	}

	deps := testQuotaCommandDeps(tmpDir)
	deps.ProviderForOverride = func(name string, billing BillingInfo) Provider {
		if name == "codex-spark" {
			return fakeProvider{name: "codex-spark", err: errors.New("spark error")}
		}
		return fakeProvider{
			name: name,
			q: Quota{
				Provider:  name,
				Used:      Float64(1),
				Total:     Float64(10),
				FetchedAt: time.Now(),
			},
		}
	}

	r, w, _ := os.Pipe()
	old := os.Stdout
	os.Stdout = w

	code := quotaListAll(deps, BillingInfo{DefaultQuotaTotal: 7000}, true, true)
	w.Close()
	os.Stdout = old
	_ = r

	if code != 0 {
		t.Fatalf("expected exit code 0 for JSON error output, got %d", code)
	}

	// Cache must now contain a failure marker.
	e, ok := readCache(cachePath)
	if !ok || e.FailedAt.IsZero() {
		t.Fatal("expected failure marker in cache after codex-spark foreground fetch error")
	}
	if !strings.Contains(e.Error, "spark error") {
		t.Fatalf("failure marker error = %q, want 'spark error'", e.Error)
	}
}

func TestNonCodexForegroundFetchErrorDoesNotForceFailureMarker(t *testing.T) {
	tmpDir := t.TempDir()
	setFixedNow(t)
	now := fixedNow()

	// Seed a valid kimi cache.
	cachePath := filepath.Join(tmpDir, "quota", "kimi-coding.json")
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o700); err != nil {
		t.Fatal(err)
	}
	cachedQ := Quota{
		Provider:  "kimi-coding",
		Used:      Float64(200),
		Total:     Float64(2048),
		FetchedAt: now,
	}
	cacheData, _ := json.MarshalIndent(cacheEntry{Quota: cachedQ, FetchedAt: now}, "", "  ")
	if err := os.WriteFile(cachePath, cacheData, 0o600); err != nil {
		t.Fatal(err)
	}

	deps := testQuotaCommandDeps(tmpDir)
	deps.ProviderForOverride = func(name string, billing BillingInfo) Provider {
		if name == "kimi-coding" {
			return fakeProvider{name: "kimi-coding", err: errors.New("network error")}
		}
		return nil
	}

	// quotaShowOne with --refresh forces a foreground fetch that fails.
	r, w, _ := os.Pipe()
	old := os.Stdout
	os.Stdout = w

	code := quotaShowOne(deps, "kimi-coding", BillingInfo{DefaultQuotaTotal: 7000}, true, true)
	w.Close()
	os.Stdout = old
	_ = r

	if code != 0 {
		t.Fatalf("expected exit code 0 for JSON error output, got %d", code)
	}

	// Cache must still contain the original valid quota (not a failure marker).
	e, ok := readCache(cachePath)
	if !ok {
		t.Fatal("cache should still be readable after non-codex foreground fetch error")
	}
	if e.Quota.Used == nil || *e.Quota.Used != 200 {
		t.Fatal("original valid quota should be preserved for non-codex provider")
	}
	if !e.FailedAt.IsZero() {
		t.Fatal("non-codex foreground fetch error must not write a failure marker")
	}
}

// --- Command-level cache-write tests ---

func TestQuotaListAllWritesCacheAfterSuccessfulFetch(t *testing.T) {
	tmpDir := t.TempDir()

	deps := CommandDeps{
		DataDir:              tmpDir,
		LoadConfig:           func() (ConfigInfo, []string, error) { return ConfigInfo{}, nil, nil },
		LoadBilling:          func() BillingInfo { return BillingInfo{DefaultQuotaTotal: 7000} },
		ResolveBigModelToken: func() string { return "" },
		ResolveKimiToken:     func() string { return "" },
		CodexBarEnabled:      func() bool { return false },
		ProviderForOverride: func(name string, billing BillingInfo) Provider {
			if name == "codex" || name == "codex-spark" || name == "kimi-coding" || name == "zhipu-coding" || name == "anthropic" {
				return fakeProvider{
					name: name,
					q: Quota{
						Provider:  name,
						Used:      Float64(100),
						Total:     Float64(1000),
						FetchedAt: timeNow(),
						Windows:   []Window{{Name: "5h", Pct: 10, WindowMinutes: 300}},
					},
				}
			}
			return nil
		},
	}

	r, w, _ := os.Pipe()
	old := os.Stdout
	os.Stdout = w

	code := quotaListAll(deps, BillingInfo{DefaultQuotaTotal: 7000}, true, false)
	w.Close()
	os.Stdout = old
	_ = r // flush output

	if code != 0 {
		t.Fatalf("expected exit code 0, got %d", code)
	}

	// Verify cache was written for codex.
	cachePath := poolCachePath(tmpDir, "codex")
	if _, err := os.Stat(cachePath); err != nil {
		t.Fatalf("codex cache should exist after successful fetch: %v", err)
	}
	q, ok := ReadCache(cachePath)
	if !ok {
		t.Fatal("codex cache should be readable")
	}
	if q.Used == nil || *q.Used != 100 {
		t.Fatalf("expected used=100, got %#v", q.Used)
	}
}

func TestQuotaShowOneWritesCacheAfterSuccessfulFetch(t *testing.T) {
	tmpDir := t.TempDir()

	deps := CommandDeps{
		DataDir:              tmpDir,
		LoadConfig:           func() (ConfigInfo, []string, error) { return ConfigInfo{}, nil, nil },
		LoadBilling:          func() BillingInfo { return BillingInfo{DefaultQuotaTotal: 7000} },
		ResolveBigModelToken: func() string { return "" },
		ResolveKimiToken:     func() string { return "" },
		CodexBarEnabled:      func() bool { return false },
		ProviderForOverride: func(name string, billing BillingInfo) Provider {
			return fakeProvider{
				name: name,
				q: Quota{
					Provider:  name,
					Used:      Float64(200),
					Total:     Float64(2000),
					FetchedAt: timeNow(),
					Windows:   []Window{{Name: "5h", Pct: 20, WindowMinutes: 300}},
				},
			}
		},
	}

	r, w, _ := os.Pipe()
	old := os.Stdout
	os.Stdout = w

	code := quotaShowOne(deps, "kimi-coding", BillingInfo{DefaultQuotaTotal: 7000}, true, false)
	w.Close()
	os.Stdout = old
	_ = r

	if code != 0 {
		t.Fatalf("expected exit code 0, got %d", code)
	}

	// Verify cache was written.
	cachePath := poolCachePath(tmpDir, "kimi-coding")
	if _, err := os.Stat(cachePath); err != nil {
		t.Fatalf("cache should exist after successful fetch: %v", err)
	}
	q, ok := ReadCache(cachePath)
	if !ok {
		t.Fatal("cache should be readable")
	}
	if q.Used == nil || *q.Used != 200 {
		t.Fatalf("expected used=200, got %#v", q.Used)
	}
}

func TestQuotaListAllWithRefreshStillWritesCache(t *testing.T) {
	tmpDir := t.TempDir()

	deps := CommandDeps{
		DataDir:              tmpDir,
		LoadConfig:           func() (ConfigInfo, []string, error) { return ConfigInfo{}, nil, nil },
		LoadBilling:          func() BillingInfo { return BillingInfo{DefaultQuotaTotal: 7000} },
		ResolveBigModelToken: func() string { return "" },
		ResolveKimiToken:     func() string { return "" },
		CodexBarEnabled:      func() bool { return false },
		ProviderForOverride: func(name string, billing BillingInfo) Provider {
			if name == "codex" || name == "codex-spark" || name == "kimi-coding" || name == "zhipu-coding" || name == "anthropic" {
				return fakeProvider{
					name: name,
					q: Quota{
						Provider:  name,
						Used:      Float64(300),
						Total:     Float64(3000),
						FetchedAt: timeNow(),
						Windows:   []Window{{Name: "5h", Pct: 30, WindowMinutes: 300}},
					},
				}
			}
			return nil
		},
	}

	r, w, _ := os.Pipe()
	old := os.Stdout
	os.Stdout = w

	// With --refresh, cache is bypassed; successful fetch must still write cache.
	code := quotaListAll(deps, BillingInfo{DefaultQuotaTotal: 7000}, true, true)
	w.Close()
	os.Stdout = old
	_ = r

	if code != 0 {
		t.Fatalf("expected exit code 0, got %d", code)
	}

	// Verify cache was written even with --refresh.
	cachePath := poolCachePath(tmpDir, "codex")
	if _, err := os.Stat(cachePath); err != nil {
		t.Fatalf("codex cache should exist after --refresh fetch: %v", err)
	}
	q, ok := ReadCache(cachePath)
	if !ok {
		t.Fatal("codex cache should be readable after --refresh")
	}
	if q.Used == nil || *q.Used != 300 {
		t.Fatalf("expected used=300, got %#v", q.Used)
	}
}

func TestQuotaListAllAPIErrorJSONNoWindows(t *testing.T) {
	tmpDir := t.TempDir()
	setFixedNow(t)
	now := fixedNow()

	// Seed stale cache (10min old, past 60s TTL) so Fetch is called.
	cachePath := filepath.Join(tmpDir, "quota", "codex.json")
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o700); err != nil {
		t.Fatal(err)
	}
	cachedQ := Quota{
		Provider:  "codex",
		Used:      Float64(500),
		Total:     Float64(7000),
		FetchedAt: now.Add(-10 * time.Minute),
	}
	cacheData, _ := json.MarshalIndent(cacheEntry{Quota: cachedQ, FetchedAt: now.Add(-10 * time.Minute)}, "", "  ")
	if err := os.WriteFile(cachePath, cacheData, 0o600); err != nil {
		t.Fatal(err)
	}

	deps := CommandDeps{
		DataDir:              tmpDir,
		LoadConfig:           func() (ConfigInfo, []string, error) { return ConfigInfo{}, nil, nil },
		LoadBilling:          func() BillingInfo { return BillingInfo{DefaultQuotaTotal: 7000} },
		ResolveBigModelToken: func() string { return "" },
		ResolveKimiToken:     func() string { return "" },
		CodexBarEnabled:      func() bool { return false },
		ProviderForOverride: func(name string, billing BillingInfo) Provider {
			return fakeProvider{name: name, err: errors.New("API failure")}
		},
	}

	r, w, _ := os.Pipe()
	old := os.Stdout
	os.Stdout = w

	code := quotaListAll(deps, BillingInfo{DefaultQuotaTotal: 7000}, true, false)
	w.Close()
	os.Stdout = old

	if code != 0 {
		t.Fatalf("expected exit code 0 for JSON error output, got %d", code)
	}

	data, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}

	var entries []map[string]any
	if err := json.Unmarshal(data, &entries); err != nil {
		t.Fatalf("failed to parse JSON: %s\nOutput: %s", err, string(data))
	}

	for _, e := range entries {
		pool, _ := e["pool"].(string)
		if pool == "codex" {
			status, _ := e["status"].(string)
			if status != "error" {
				t.Fatalf("codex status = %q, want error", status)
			}
			errMsg, _ := e["error"].(string)
			if !strings.Contains(errMsg, "API failure") {
				t.Fatalf("codex error = %q, want 'API failure'", errMsg)
			}
			// Must not have stale windows or stale data.
			if _, hasWindows := e["windows"]; hasWindows {
				t.Fatal("error JSON must not include stale windows")
			}
			if _, hasUsed := e["used"]; hasUsed {
				t.Fatal("error JSON must not include stale used")
			}
			if _, hasTotal := e["total"]; hasTotal {
				t.Fatal("error JSON must not include stale total")
			}
		}
	}
}

// TestNonCodexStalePreservation verifies that non-Codex providers
// still return stale data on fetch failure (FailClosed=false regression).
func TestNonCodexStalePreservation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")
	old := timeNow().Add(-2 * time.Minute)
	oldQ := Quota{Provider: "kimi-coding", Used: Float64(100), Total: Float64(2048), FetchedAt: old}
	if err := writeCache(path, oldQ); err != nil {
		t.Fatal(err)
	}

	// Non-FailClosed provider with fetch failure must preserve stale data.
	p := &CachedProvider{
		Inner: fakeProvider{
			name: "kimi-coding",
			err:  errors.New("network error"),
		},
		Path:       path,
		TTL:        60 * time.Second, // cache is 2min old, past TTL
		FailClosed: false,
	}

	q, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatalf("expected stale fallback, not error: %v", err)
	}
	if !q.Stale {
		t.Fatal("non-FailClosed provider should return stale=true on fetch failure with valid cache")
	}
	if q.Used == nil || *q.Used != 100 {
		t.Fatalf("expected preserved used=100, got %#v", q.Used)
	}
}

// --- RequiredSource regression tests ---

func TestCachedProviderFailClosedRequiredSourceMismatchCallsInner(t *testing.T) {
	// FailClosed normal mode with a fresh cache that has a legacy
	// source (empty). RequiredSource="codex-app-server", mismatch
	// must bypass cache and call Inner.
	path := filepath.Join(t.TempDir(), "quota.json")
	now := timeNow()
	fresh := Quota{Provider: "codex", Source: "", Used: Float64(1), Total: Float64(10), FetchedAt: now}
	if err := writeCache(path, fresh); err != nil {
		t.Fatal(err)
	}

	p := &CachedProvider{
		Inner: fakeProvider{
			name: "codex",
			q:    Quota{Provider: "codex", Source: "codex-app-server", Used: Float64(2), Total: Float64(10), FetchedAt: timeNow()},
		},
		Path:           path,
		TTL:            time.Hour,
		FailClosed:     true,
		RequiredSource: "codex-app-server",
	}
	q, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatalf("Fetch should succeed via Inner: %v", err)
	}
	if q.Used == nil || *q.Used != 2 {
		t.Fatalf("expected Inner fresh used=2 (legacy cache bypassed), got %#v", q.Used)
	}
	// Cache should be updated with the correct source.
	cached, ok := readCache(path)
	if !ok {
		t.Fatal("cache should exist after Inner fetch")
	}
	if cached.Quota.Source != "codex-app-server" {
		t.Fatalf("cache Source = %q, want codex-app-server", cached.Quota.Source)
	}
}

func TestCachedProviderFailClosedSWROnlyRequiredSourceMismatchReturnsError(t *testing.T) {
	// FailClosed + SWROnly with fresh legacy-source cache must
	// return error and kick refresh.
	path := filepath.Join(t.TempDir(), "quota.json")
	now := timeNow()
	fresh := Quota{Provider: "codex", Source: "", Used: Float64(1), Total: Float64(10), FetchedAt: now}
	if err := writeCache(path, fresh); err != nil {
		t.Fatal(err)
	}

	noop := &NoopSpawner{}
	p := &CachedProvider{
		Inner:          fetchIsFatal{t: t},
		Path:           path,
		TTL:            time.Hour,
		RefreshAge:     30 * time.Second,
		SWROnly:        true,
		FailClosed:     true,
		RequiredSource: "codex-app-server",
		Spawner:        noop,
	}

	_, err := p.Fetch(context.Background())
	if err == nil {
		t.Fatal("expected error on RequiredSource mismatch with FailClosed+SWROnly")
	}
	if !strings.Contains(err.Error(), "source mismatch") {
		t.Fatalf("error = %q, want source mismatch", err.Error())
	}
	if noop.Calls != 1 {
		t.Fatalf("expected 1 spawn kick, got %d", noop.Calls)
	}
}

func TestCachedProviderFailClosedSWROnlyRequiredSourceMatchReturnsCache(t *testing.T) {
	// FailClosed + SWROnly with fresh correct-source cache must
	// return cached data normally.
	path := filepath.Join(t.TempDir(), "quota.json")
	now := timeNow()
	fresh := Quota{Provider: "codex", Source: "codex-app-server", Used: Float64(5), Total: Float64(10), FetchedAt: now}
	if err := writeCache(path, fresh); err != nil {
		t.Fatal(err)
	}

	p := &CachedProvider{
		Inner:          fetchIsFatal{t: t},
		Path:           path,
		TTL:            time.Hour,
		RefreshAge:     30 * time.Second,
		SWROnly:        true,
		FailClosed:     true,
		RequiredSource: "codex-app-server",
		Spawner:        &NoopSpawner{},
	}

	q, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatalf("expected no error on matching source: %v", err)
	}
	if q.Used == nil || *q.Used != 5 {
		t.Fatalf("expected used=5, got %#v", q.Used)
	}
}

func TestQuotaListAllCacheEligibleRejectsLegacyCodexSource(t *testing.T) {
	// A fresh codex cache without source="codex-app-server" must be
	// bypassed and provider fetch used.
	tmpDir := t.TempDir()
	setFixedNow(t)
	now := fixedNow()

	cachePath := filepath.Join(tmpDir, "quota", "codex.json")
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o700); err != nil {
		t.Fatal(err)
	}
	cachedQ := Quota{
		Provider:  "codex",
		Source:    "", // legacy — no source
		Used:      Float64(500),
		Total:     Float64(7000),
		FetchedAt: now,
	}
	cacheData, _ := json.MarshalIndent(cacheEntry{Quota: cachedQ, FetchedAt: now}, "", "  ")
	if err := os.WriteFile(cachePath, cacheData, 0o600); err != nil {
		t.Fatal(err)
	}

	var providerCalled bool
	deps := testQuotaCommandDeps(tmpDir)
	deps.ProviderForOverride = func(name string, billing BillingInfo) Provider {
		if name == "codex" {
			providerCalled = true
			return fakeProvider{
				name: "codex",
				q: Quota{
					Provider:  "codex",
					Source:    "codex-app-server",
					Used:      Float64(300),
					Total:     Float64(7000),
					FetchedAt: timeNow(),
				},
			}
		}
		return nil
	}

	result, code := captureQuotaShowOneJSON(t, deps, "codex")
	if code != 0 {
		t.Fatalf("quotaShowOne exit code = %d, want 0", code)
	}
	if !providerCalled {
		t.Fatal("Provider must be called when legacy codex cache is rejected")
	}
	if used, _ := result["used"].(float64); used != 300 {
		t.Fatalf("used = %f, want 300 (from provider)", used)
	}
}

func TestQuotaShowOneFutureDatedCacheBypassed(t *testing.T) {
	// A cache with a future FetchedAt (negative age) must be bypassed.
	tmpDir := t.TempDir()
	setFixedNow(t)
	now := fixedNow()

	cachePath := filepath.Join(tmpDir, "quota", "kimi-coding.json")
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o700); err != nil {
		t.Fatal(err)
	}
	// Future-dated cache (10 minutes in the future).
	future := now.Add(10 * time.Minute)
	cachedQ := Quota{
		Provider:  "kimi-coding",
		Used:      Float64(500),
		Total:     Float64(2048),
		FetchedAt: future,
	}
	cacheData, _ := json.MarshalIndent(cacheEntry{Quota: cachedQ, FetchedAt: future}, "", "  ")
	if err := os.WriteFile(cachePath, cacheData, 0o600); err != nil {
		t.Fatal(err)
	}

	var providerCalled bool
	deps := testQuotaCommandDeps(tmpDir)
	deps.ProviderForOverride = func(name string, billing BillingInfo) Provider {
		if name == "kimi-coding" {
			providerCalled = true
			return fakeProvider{
				name: "kimi-coding",
				q: Quota{
					Provider:  "kimi-coding",
					Used:      Float64(100),
					Total:     Float64(2048),
					FetchedAt: timeNow(),
				},
			}
		}
		return nil
	}

	result, code := captureQuotaShowOneJSON(t, deps, "kimi")
	if code != 0 {
		t.Fatalf("quotaShowOne exit code = %d, want 0", code)
	}
	if !providerCalled {
		t.Fatal("Provider must be called when future-dated cache is rejected")
	}
	if used, _ := result["used"].(float64); used != 100 {
		t.Fatalf("used = %f, want 100 (from provider)", used)
	}
}

func TestCacheEligibleForPoolBlankSourceAcceptedByNonCodex(t *testing.T) {
	// Non-Codex pools must accept blank source.
	if !cacheEligibleForPool(Quota{FetchedAt: time.Now(), Source: ""}, "kimi-coding") {
		t.Fatal("kimi-coding should accept blank source")
	}
	if !cacheEligibleForPool(Quota{FetchedAt: time.Now(), Source: "codex-app-server"}, "codex") {
		t.Fatal("codex with correct source should be accepted")
	}
	if cacheEligibleForPool(Quota{FetchedAt: time.Now(), Source: ""}, "codex") {
		t.Fatal("codex with blank source must be rejected")
	}
	if cacheEligibleForPool(Quota{FetchedAt: time.Now(), Source: ""}, "codex-spark") {
		t.Fatal("codex-spark with blank source must be rejected")
	}
}
