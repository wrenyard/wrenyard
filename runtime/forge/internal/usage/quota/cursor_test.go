package quota

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/cursor"
	_ "modernc.org/sqlite"
)

const testCursorToken = "cursor-test-token-not-a-secret"

// createCursorStateDB builds a temporary Cursor Desktop state.vscdb containing
// (optionally) the access token under cursorAuth/accessToken.
func createCursorStateDB(t *testing.T, dir, token string) string {
	t.Helper()
	path := filepath.Join(dir, "state.vscdb")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open state db: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT)`); err != nil {
		t.Fatalf("create ItemTable: %v", err)
	}
	if token != "" {
		if _, err := db.Exec(`INSERT INTO ItemTable (key, value) VALUES (?, ?)`, "cursorAuth/accessToken", token); err != nil {
			t.Fatalf("insert token: %v", err)
		}
	}
	return path
}

func cursorTestServer(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return srv
}

func TestCursorProviderTeamTwoWindowSuccess(t *testing.T) {
	dir := t.TempDir()
	statePath := createCursorStateDB(t, dir, testCursorToken)

	srv := cursorTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("method = %s, want POST", r.Method)
		}
		if ct := r.Header.Get("Content-Type"); ct != "application/json" {
			t.Fatalf("Content-Type = %q, want application/json", ct)
		}
		if r.Header.Get("Connect-Protocol-Version") != "1" {
			t.Fatalf("Connect-Protocol-Version = %q, want 1", r.Header.Get("Connect-Protocol-Version"))
		}
		if auth := r.Header.Get("Authorization"); auth != "Bearer "+testCursorToken {
			t.Fatalf("Authorization = %q, want Bearer token", auth)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{
			"billingCycleStart":"2026-08-01T00:00:00Z",
			"billingCycleEnd":"2026-08-31T00:00:00Z",
			"planUsage":{"autoPercentUsed":42.5,"apiPercentUsed":12.3,"totalPercentUsed":54.8}
		}`))
	})

	fixed := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)
	p := CursorProvider{StatePath: statePath, Endpoint: srv.URL, Now: func() time.Time { return fixed }}
	q, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if q.Provider != "cursor" {
		t.Fatalf("provider = %q, want cursor", q.Provider)
	}
	if q.Source != "cursor-dashboard" {
		t.Fatalf("source = %q, want cursor-dashboard", q.Source)
	}
	if q.Label != "Cursor Team" {
		t.Fatalf("label = %q, want Cursor Team", q.Label)
	}
	if !q.FetchedAt.Equal(fixed) {
		t.Fatalf("FetchedAt = %v, want %v", q.FetchedAt, fixed)
	}
	if len(q.Windows) != 2 {
		t.Fatalf("expected 2 windows, got %#v", q.Windows)
	}
	if q.Windows[0].Name != "Cursor" || q.Windows[0].Pct != 42.5 {
		t.Fatalf("window[0] = %#v, want Cursor 42.5", q.Windows[0])
	}
	if q.Windows[1].Name != "Other" || q.Windows[1].Pct != 12.3 {
		t.Fatalf("window[1] = %#v, want Other 12.3", q.Windows[1])
	}
	for _, w := range q.Windows {
		if w.WindowMinutes != 43200 {
			t.Fatalf("window %s minutes = %d, want 43200", w.Name, w.WindowMinutes)
		}
		if w.ResetsAt == nil || !w.ResetsAt.Equal(time.Date(2026, 8, 31, 0, 0, 0, 0, time.UTC)) {
			t.Fatalf("window %s resetsAt = %v, want 2026-08-31T00:00:00Z", w.Name, w.ResetsAt)
		}
	}

	// Credential hygiene: the token must never appear in the quota JSON.
	raw, err := json.Marshal(q)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), testCursorToken) {
		t.Fatal("access token leaked into quota JSON")
	}
}

func TestCursorProviderTotalFallback(t *testing.T) {
	dir := t.TempDir()
	statePath := createCursorStateDB(t, dir, testCursorToken)

	srv := cursorTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"billingCycleEnd":"2026-08-31T00:00:00Z","planUsage":{"totalPercentUsed":80}}`))
	})

	p := CursorProvider{StatePath: statePath, Endpoint: srv.URL}
	q, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(q.Windows) != 1 || q.Windows[0].Name != "Total" || q.Windows[0].Pct != 80 {
		t.Fatalf("fallback windows = %#v, want single Total 80", q.Windows)
	}
}

func TestCursorProviderClamping(t *testing.T) {
	dir := t.TempDir()
	statePath := createCursorStateDB(t, dir, testCursorToken)

	srv := cursorTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"planUsage":{"autoPercentUsed":150,"apiPercentUsed":-5}}`))
	})

	p := CursorProvider{StatePath: statePath, Endpoint: srv.URL}
	q, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(q.Windows) != 2 {
		t.Fatalf("windows = %#v, want 2", q.Windows)
	}
	if q.Windows[0].Pct != 100 {
		t.Fatalf("auto clamped = %v, want 100", q.Windows[0].Pct)
	}
	if q.Windows[1].Pct != 0 {
		t.Fatalf("api clamped = %v, want 0", q.Windows[1].Pct)
	}
}

func TestCursorProviderMissingToken(t *testing.T) {
	dir := t.TempDir()
	statePath := createCursorStateDB(t, dir, "") // no token row

	p := CursorProvider{StatePath: statePath}
	_, err := p.Fetch(context.Background())
	if err == nil {
		t.Fatal("expected error when token is missing")
	}
	if strings.Contains(err.Error(), testCursorToken) {
		t.Fatal("error leaked a token")
	}
}

func TestCursorProviderMissingStateDB(t *testing.T) {
	p := CursorProvider{StatePath: filepath.Join(t.TempDir(), "does-not-exist.vscdb")}
	_, err := p.Fetch(context.Background())
	if err == nil {
		t.Fatal("expected error when state database is missing")
	}
}

func TestCursorProviderUnauthorized(t *testing.T) {
	dir := t.TempDir()
	statePath := createCursorStateDB(t, dir, testCursorToken)

	srv := cursorTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	})

	p := CursorProvider{StatePath: statePath, Endpoint: srv.URL}
	_, err := p.Fetch(context.Background())
	if err == nil {
		t.Fatal("expected error on 401")
	}
	if !strings.Contains(err.Error(), "401") {
		t.Fatalf("expected status in error, got %v", err)
	}
	if strings.Contains(err.Error(), testCursorToken) {
		t.Fatal("error leaked a token")
	}
}

func TestCursorProviderMalformedResponse(t *testing.T) {
	dir := t.TempDir()
	statePath := createCursorStateDB(t, dir, testCursorToken)

	srv := cursorTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte("<html>not json</html>"))
	})

	p := CursorProvider{StatePath: statePath, Endpoint: srv.URL}
	_, err := p.Fetch(context.Background())
	if err == nil {
		t.Fatal("expected error on malformed response")
	}
	if !strings.Contains(err.Error(), "malformed") {
		t.Fatalf("expected malformed error, got %v", err)
	}
}

func TestCursorProviderNoWindows(t *testing.T) {
	dir := t.TempDir()
	statePath := createCursorStateDB(t, dir, testCursorToken)

	srv := cursorTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"planUsage":{}}`))
	})

	p := CursorProvider{StatePath: statePath, Endpoint: srv.URL}
	_, err := p.Fetch(context.Background())
	if err == nil {
		t.Fatal("expected error when no usage windows available")
	}
}

func TestCursorProviderNetworkFailure(t *testing.T) {
	dir := t.TempDir()
	statePath := createCursorStateDB(t, dir, testCursorToken)

	p := CursorProvider{StatePath: statePath, Endpoint: "http://127.0.0.1:1/unreachable", HTTPClient: &http.Client{Timeout: time.Second}}
	_, err := p.Fetch(context.Background())
	if err == nil {
		t.Fatal("expected error on network failure")
	}
	if strings.Contains(err.Error(), testCursorToken) {
		t.Fatal("error leaked a token")
	}
}

func TestCursorProviderErrorNeverContainsToken(t *testing.T) {
	// A network failure, 401, malformed, and missing-token paths all assert
	// token hygiene; this ties the invariant across the error construction.
	dir := t.TempDir()
	statePath := createCursorStateDB(t, dir, testCursorToken)

	srv := cursorTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	})

	p := CursorProvider{StatePath: statePath, Endpoint: srv.URL}
	_, err := p.Fetch(context.Background())
	if err == nil {
		t.Fatal("expected error")
	}
	if strings.Contains(err.Error(), testCursorToken) {
		t.Fatal("error leaked the access token")
	}
}

func TestCursorDefaultStatePathResolution(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	// Darwin is the host platform here; assert the macOS path resolves under HOME
	// via the shared cursor.StatePath helper.
	want := filepath.Join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb")
	if got := cursor.StatePath(home); got != want {
		t.Fatalf("darwin path = %q, want %q", got, want)
	}
}
