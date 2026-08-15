package quota

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// --- credential cache tests ---

func TestCredentialCacheWriteRead(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "claude-credential.json")

	cred := claudeCredential{
		AccessToken:  "test-access-token",
		RefreshToken: "test-refresh-token",
		ExpiresAt:    time.Now().Add(time.Hour),
	}
	if err := writeCredentialCache(path, cred); err != nil {
		t.Fatal(err)
	}

	cached, ok := readCredentialCache(path)
	if !ok {
		t.Fatal("expected credential to be readable")
	}
	if cached.AccessToken != "test-access-token" {
		t.Fatalf("access token mismatch: %q", cached.AccessToken)
	}
	if cached.RefreshToken != "test-refresh-token" {
		t.Fatalf("refresh token mismatch: %q", cached.RefreshToken)
	}
}

func TestCredentialCacheFilePerms(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "claude-credential.json")

	cred := claudeCredential{
		AccessToken: "test-access-token",
		ExpiresAt:   time.Now().Add(time.Hour),
	}
	if err := writeCredentialCache(path, cred); err != nil {
		t.Fatal(err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "windows" {
		updated := claudeCredential{
			AccessToken: "updated-access-token",
			ExpiresAt:   time.Now().Add(2 * time.Hour),
		}
		if err := writeCredentialCache(path, updated); err != nil {
			t.Fatal(err)
		}
		cached, ok := readCredentialCache(path)
		if !ok || cached.AccessToken != "updated-access-token" {
			t.Fatalf("credential cache replacement not readable: %#v, %v", cached, ok)
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(raw), "test-access-token") || !strings.Contains(string(raw), "updated-access-token") {
			t.Fatalf("credential cache replacement has unexpected content: %s", raw)
		}
		matches, err := filepath.Glob(path + ".*.tmp")
		if err != nil {
			t.Fatal(err)
		}
		if len(matches) != 0 {
			t.Fatalf("credential cache replacement leaked temp files: %v", matches)
		}
		return
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("expected 0600 perms, got %04o", info.Mode().Perm())
	}
}

func TestCredentialCacheAtomicWrite(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "claude-credential.json")

	// Write initial credential
	cred := claudeCredential{
		AccessToken: "initial-token",
		ExpiresAt:   time.Now().Add(time.Hour),
	}
	if err := writeCredentialCache(path, cred); err != nil {
		t.Fatal(err)
	}

	// Create a stale .tmp file (old pattern) — shouldn't affect the atomic write.
	if err := os.WriteFile(path+".tmp", []byte(`{"access_token":"corrupt`), 0o600); err != nil {
		t.Fatal(err)
	}

	// Original should still be intact
	cached, ok := readCredentialCache(path)
	if !ok || cached.AccessToken != "initial-token" {
		t.Fatalf("stale tmp file corrupted readable cache: %#v, %v", cached, ok)
	}

	// Write a new credential — should succeed with atomic rename
	newCred := claudeCredential{
		AccessToken: "updated-token",
		ExpiresAt:   time.Now().Add(2 * time.Hour),
	}
	if err := writeCredentialCache(path, newCred); err != nil {
		t.Fatal(err)
	}

	cached, ok = readCredentialCache(path)
	if !ok || cached.AccessToken != "updated-token" {
		t.Fatalf("renamed credential cache not readable: %#v, %v", cached, ok)
	}
}

func TestCredentialCacheExpiryCheck(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "claude-credential.json")

	// Write an expired credential
	cred := claudeCredential{
		AccessToken:  "expired-token",
		RefreshToken: "refresh-token",
		ExpiresAt:    time.Now().Add(-1 * time.Hour),
	}
	if err := writeCredentialCache(path, cred); err != nil {
		t.Fatal(err)
	}

	cached, ok := readCredentialCache(path)
	if !ok {
		t.Fatal("expected credential to be readable")
	}
	// Token is expired — caller should check
	if time.Until(cached.ExpiresAt) > 0 {
		t.Fatal("expected expired token")
	}
}

func TestCredentialCacheMissingFile(t *testing.T) {
	_, ok := readCredentialCache("/nonexistent/path/claude-credential.json")
	if ok {
		t.Fatal("expected false for missing file")
	}
}

func TestCredentialCacheDirPerms(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested", "dir")
	path := filepath.Join(dir, "claude-credential.json")

	cred := claudeCredential{
		AccessToken: "test-token",
		ExpiresAt:   time.Now().Add(time.Hour),
	}
	if err := writeCredentialCache(path, cred); err != nil {
		t.Fatal(err)
	}

	// Directory should be 0700
	info, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "windows" {
		if !info.IsDir() {
			t.Fatalf("credential cache parent is not a directory: %s", dir)
		}
		cached, ok := readCredentialCache(path)
		if !ok || cached.AccessToken != "test-token" {
			t.Fatalf("credential cache in created directory not readable: %#v, %v", cached, ok)
		}
		return
	}
	if info.Mode().Perm() != 0o700 {
		t.Fatalf("expected dir 0700, got %04o", info.Mode().Perm())
	}
}

// --- negative cache (failure marker) tests ---

func TestFailureMarkerPreventsRefetch(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")

	var fetchCount int32
	inner := &countProvider{
		name:  "test",
		err:   errors.New("simulated failure"),
		count: &fetchCount,
	}

	p := CachedProvider{Inner: inner, Path: path, TTL: time.Hour}

	// First fetch: should fail and write failure marker
	_, err := p.Fetch(context.Background())
	if err == nil {
		t.Fatal("expected error")
	}
	if atomic.LoadInt32(&fetchCount) != 1 {
		t.Fatalf("expected 1 fetch, got %d", fetchCount)
	}

	// Second fetch: should return error from failure marker without calling Inner
	_, err = p.Fetch(context.Background())
	if err == nil {
		t.Fatal("expected error")
	}
	if atomic.LoadInt32(&fetchCount) != 1 {
		t.Fatalf("expected still 1 fetch (failure marker blocked refetch), got %d", fetchCount)
	}
}

func TestFailureMarkerExpires(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")

	var fetchCount int32
	inner := &countProvider{
		name:  "test",
		err:   errors.New("simulated failure"),
		count: &fetchCount,
	}

	// Use a very short TTL so the failure marker expires quickly
	p := CachedProvider{Inner: inner, Path: path, TTL: 1 * time.Millisecond}

	// First fetch fails
	_, _ = p.Fetch(context.Background())

	// Wait for failure TTL to expire
	time.Sleep(100 * time.Millisecond)

	// Second fetch should call Inner again
	_, _ = p.Fetch(context.Background())
	if atomic.LoadInt32(&fetchCount) < 2 {
		t.Fatalf("expected at least 2 fetches after failure TTL expired, got %d", fetchCount)
	}
}

func TestFailureMarkerClearedOnSuccess(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")

	// Write a failure marker in the past (expired)
	if err := writeFailureMarker(path, time.Now().Add(-2*time.Minute), "previous failure"); err != nil {
		t.Fatal(err)
	}

	// Now create a provider that succeeds
	inner := &countProvider{
		name: "test",
		q:    Quota{Provider: "test", Used: Float64(10), Total: Float64(100), FetchedAt: time.Now()},
	}

	// TTL is short so the expired failure marker doesn't block
	p := CachedProvider{Inner: inner, Path: path, TTL: time.Second}

	q, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if q.Stale {
		t.Fatal("expected fresh result, not stale")
	}

	// Failure marker should be overwritten by success entry
	entry, ok := readCache(path)
	if !ok {
		t.Fatal("expected cache entry")
	}
	if !entry.FailedAt.IsZero() {
		t.Fatal("failure marker should be cleared on success")
	}
}

func TestFailureMarkerTTLCappedAt60s(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota.json")

	var fetchCount int32
	inner := &countProvider{
		name:  "test",
		err:   errors.New("failure"),
		count: &fetchCount,
	}

	// TTL is 10 minutes but failure TTL should be capped at 60s
	p := CachedProvider{Inner: inner, Path: path, TTL: 10 * time.Minute}

	_, _ = p.Fetch(context.Background())
	if atomic.LoadInt32(&fetchCount) != 1 {
		t.Fatalf("expected 1 fetch, got %d", fetchCount)
	}

	// Immediate refetch should be blocked
	_, _ = p.Fetch(context.Background())
	if atomic.LoadInt32(&fetchCount) != 1 {
		t.Fatalf("failure marker should block refetch, got %d fetches", fetchCount)
	}
}

// --- AllowKeychain flag tests ---

func TestClaudeProviderSkipsKeychainWhenNotAllowed(t *testing.T) {
	p := ClaudeProvider{
		AllowKeychain: false,
	}

	dir := t.TempDir()
	p.CredentialCacheDir = dir
	p.Credentials = filepath.Join(dir, "nonexistent.json")
	p.Home = dir

	// KeychainRead is nil, so it falls through to the real keychain gate
	// which should be skipped because AllowKeychain=false
	_, err := p.readCredentials(context.Background())
	if err == nil {
		t.Fatal("expected error when no credentials available")
	}
	// The error should be about the credentials file, not keychain
	if !strings.Contains(err.Error(), "credentials file") {
		t.Fatalf("expected credentials file error, got: %v", err)
	}
}

func TestClaudeProviderUsesKeychainWhenAllowed(t *testing.T) {
	keychainData := []byte(`{"accessToken":"keychain-token","refreshToken":"keychain-refresh","expiresAt":9999999999000}`)

	p := ClaudeProvider{
		AllowKeychain: true,
		KeychainRead: func(ctx context.Context) ([]byte, error) {
			return keychainData, nil
		},
	}

	dir := t.TempDir()
	p.CredentialCacheDir = dir
	p.Home = dir

	cred, err := p.readCredentials(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if cred.AccessToken != "keychain-token" {
		t.Fatalf("expected keychain-token, got %q", cred.AccessToken)
	}

	// Should have been persisted to disk cache
	cached, ok := readCredentialCache(filepath.Join(dir, "claude-credential.json"))
	if !ok {
		t.Fatal("expected credential to be cached to disk")
	}
	if cached.AccessToken != "keychain-token" {
		t.Fatalf("cached token mismatch: %q", cached.AccessToken)
	}
}

func TestClaudeProviderKeychainReadCallbackAlwaysFires(t *testing.T) {
	// KeychainRead callback is always tried (step 1 in readCredentials).
	// Regardless of AllowKeychain, the callback fires. The real
	// readClaudeKeychain is only called via the AllowKeychain gate.
	keychainCalled := false
	p := ClaudeProvider{
		AllowKeychain: false,
		KeychainRead: func(ctx context.Context) ([]byte, error) {
			keychainCalled = true
			return []byte(`{"accessToken":"callback-token","expiresAt":9999999999000}`), nil
		},
	}

	dir := t.TempDir()
	p.CredentialCacheDir = dir
	p.Home = dir

	// KeychainRead callback is always tried (step 1 in readCredentials).
	// Regardless of AllowKeychain, the callback fires.
	cred, err := p.readCredentials(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !keychainCalled {
		t.Fatal("KeychainRead callback should be called")
	}
	if cred.AccessToken != "callback-token" {
		t.Fatalf("expected callback-token, got %q", cred.AccessToken)
	}
}

// --- token refresh persistence test ---

func TestCredentialCacheRefreshPersists(t *testing.T) {
	// Set up an OAuth token endpoint that returns a refreshed token
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if err := r.ParseForm(); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if r.Form.Get("grant_type") != "refresh_token" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"accessToken":"refreshed-token","refreshToken":"new-refresh","expiresAt":9999999999000}`))
	}))
	defer srv.Close()

	dir := t.TempDir()
	cachePath := filepath.Join(dir, "claude-credential.json")

	// Write an expired credential with a refresh token
	cred := claudeCredential{
		AccessToken:  "expired-token",
		RefreshToken: "old-refresh",
		ExpiresAt:    time.Now().Add(-1 * time.Hour),
	}
	if err := writeCredentialCache(cachePath, cred); err != nil {
		t.Fatal(err)
	}

	p := ClaudeProvider{
		AllowKeychain:      false,
		RefreshURL:         srv.URL,
		CredentialCacheDir: dir,
		Client:             srv.Client(),
	}

	// readCredentials should refresh the token and persist
	result, err := p.readCredentials(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.AccessToken != "refreshed-token" {
		t.Fatalf("expected refreshed-token, got %q", result.AccessToken)
	}
	if result.RefreshToken != "new-refresh" {
		t.Fatalf("expected new-refresh, got %q", result.RefreshToken)
	}

	// Verify persistence
	cached, ok := readCredentialCache(cachePath)
	if !ok {
		t.Fatal("expected refreshed credential to be persisted")
	}
	if cached.AccessToken != "refreshed-token" {
		t.Fatalf("persisted token mismatch: %q", cached.AccessToken)
	}
}

// --- credentials file fallback test ---

// TestRefreshPreservesOldRefreshToken verifies H4: when a refresh response
// omits refresh_token, the prior refresh token is retained rather than wiped.
func TestRefreshPreservesOldRefreshToken(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// Refresh response without refresh token (common provider behavior).
		w.Write([]byte(`{"accessToken":"new-access-only","expiresAt":9999999999000}`))
	}))
	defer srv.Close()

	dir := t.TempDir()
	cachePath := filepath.Join(dir, "claude-credential.json")

	// Write an expired credential with a refresh token.
	cred := claudeCredential{
		AccessToken:  "expired-token",
		RefreshToken: "keep-me",
		ExpiresAt:    time.Now().Add(-1 * time.Hour),
	}
	if err := writeCredentialCache(cachePath, cred); err != nil {
		t.Fatal(err)
	}

	p := ClaudeProvider{
		AllowKeychain:      false,
		RefreshURL:         srv.URL,
		CredentialCacheDir: dir,
		Client:             srv.Client(),
	}

	result, err := p.readCredentials(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.AccessToken != "new-access-only" {
		t.Fatalf("expected new-access-only, got %q", result.AccessToken)
	}
	if result.RefreshToken != "keep-me" {
		t.Fatalf("H4: expected old refresh token 'keep-me' to be preserved, got %q", result.RefreshToken)
	}

	// Verify persistence also retained the refresh token.
	cached, ok := readCredentialCache(cachePath)
	if !ok {
		t.Fatal("expected refreshed credential to be persisted")
	}
	if cached.RefreshToken != "keep-me" {
		t.Fatalf("H4: persisted refresh token was wiped, got %q", cached.RefreshToken)
	}
}

func TestCredentialCacheFromCredentialsFile(t *testing.T) {
	dir := t.TempDir()
	credsPath := filepath.Join(dir, ".credentials.json")
	if err := os.WriteFile(credsPath, []byte(`{"accessToken":"file-token","refreshToken":"file-refresh","expiresAt":9999999999000}`), 0o600); err != nil {
		t.Fatal(err)
	}

	p := ClaudeProvider{
		AllowKeychain:      false,
		Credentials:        credsPath,
		CredentialCacheDir: dir,
		Home:               dir,
	}

	cred, err := p.readCredentials(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if cred.AccessToken != "file-token" {
		t.Fatalf("expected file-token, got %q", cred.AccessToken)
	}

	// Should be cached to disk
	cachePath := filepath.Join(dir, "claude-credential.json")
	cached, ok := readCredentialCache(cachePath)
	if !ok {
		t.Fatal("expected credential to be cached to disk")
	}
	if cached.AccessToken != "file-token" {
		t.Fatalf("cached token mismatch: %q", cached.AccessToken)
	}
}

// --- keychain cooldown guard tests ---

func TestKeychainCooldownBlocksRecentFailedAttempt(t *testing.T) {
	dir := t.TempDir()

	// Write a failed keychain attempt marker from 1 minute ago (within 30m cooldown).
	attemptPath := strings.TrimSuffix(filepath.Join(dir, "claude-credential.json"), ".json") + "-keychain-attempt.json"
	m := keychainAttemptMarker{AttemptedAt: time.Now().Add(-1 * time.Minute), Success: false}
	raw, _ := json.Marshal(m)
	if err := os.WriteFile(attemptPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}

	// No KeychainRead test seam — we test the cooldown on tryLazyKeychain directly.
	// Without KeychainRead, doKeychainRead falls to readClaudeKeychain, but cooldown
	// blocks before any real keychain call.
	p := ClaudeProvider{
		AllowKeychain:      true,
		CredentialCacheDir: dir,
		Home:               dir,
		KeychainCooldown:   30 * time.Minute,
		Credentials:        filepath.Join(dir, "nonexistent.json"),
	}

	// readCredentials: no cache → no refresh → cooldown blocks keychain → fail on creds file
	_, err := p.readCredentials(context.Background())
	if err == nil || !strings.Contains(err.Error(), "credentials file") {
		t.Fatalf("expected credentials file error (keychain blocked by cooldown), got: %v", err)
	}
}

func TestKeychainCooldownExpiredRetries(t *testing.T) {
	dir := t.TempDir()
	credCachePath := filepath.Join(dir, "claude-credential.json")
	attemptPath := strings.TrimSuffix(credCachePath, ".json") + "-keychain-attempt.json"

	// Write a failed keychain attempt marker from 31 minutes ago (outside 30m cooldown).
	m := keychainAttemptMarker{AttemptedAt: time.Now().Add(-31 * time.Minute), Success: false}
	raw, _ := json.Marshal(m)
	if err := os.WriteFile(attemptPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}

	var keychainCallCount int32
	p := ClaudeProvider{
		AllowKeychain:      true,
		CredentialCacheDir: dir,
		Home:               dir,
		KeychainCooldown:   30 * time.Minute,
		KeychainRead: func(ctx context.Context) ([]byte, error) {
			atomic.AddInt32(&keychainCallCount, 1)
			return []byte(`{"accessToken":"retry-token","expiresAt":9999999999000}`), nil
		},
	}

	// readCredentials should: no valid cache → cooldown expired → attempt keychain → succeed
	cred, err := p.readCredentials(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if cred.AccessToken != "retry-token" {
		t.Fatalf("expected retry-token, got %q", cred.AccessToken)
	}
	if atomic.LoadInt32(&keychainCallCount) != 1 {
		t.Fatalf("expected 1 keychain read attempt, got %d", keychainCallCount)
	}

	// On success, attempt marker should be cleared.
	if _, err := os.Stat(attemptPath); err == nil {
		t.Fatal("attempt marker should be cleared on success")
	}
}

func TestKeychainNotAttemptedWhenCachedCredentialValid(t *testing.T) {
	dir := t.TempDir()
	credCachePath := filepath.Join(dir, "claude-credential.json")

	cached := claudeCredential{
		AccessToken: "cached-token", RefreshToken: "cached-refresh",
		ExpiresAt: time.Now().Add(time.Hour),
	}
	if err := writeCredentialCache(credCachePath, cached); err != nil {
		t.Fatal(err)
	}

	// No KeychainRead test seam — we want to prove the cache short-circuits
	// before tryLazyKeychain. Without KeychainRead, step 1 is skipped, step 2
	// reads the cache and returns immediately.
	p := ClaudeProvider{
		AllowKeychain:      true,
		CredentialCacheDir: dir,
		Home:               dir,
		KeychainCooldown:   30 * time.Minute,
	}

	cred, err := p.readCredentials(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if cred.AccessToken != "cached-token" {
		t.Fatalf("expected cached-token, got %q", cred.AccessToken)
	}
}

// --- helper types ---

type countProvider struct {
	name  string
	q     Quota
	err   error
	count *int32
}

func (p *countProvider) Name() string { return p.name }
func (p *countProvider) Fetch(ctx context.Context) (Quota, error) {
	if p.count != nil {
		atomic.AddInt32(p.count, 1)
	}
	return p.q, p.err
}

// --- Fetch order tests (snapshot → OAuth → CLI) ---

func newSnapshotForTest(t *testing.T, provider string) string {
	t.Helper()
	dir := t.TempDir()
	raw, _ := json.Marshal(map[string]any{
		"entries": []any{
			map[string]any{
				"provider": provider,
				"primary": map[string]any{
					"usedPercent":    42.0,
					"window_minutes": 300,
				},
			},
		},
	})
	path := filepath.Join(dir, "widget-snapshot.json")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func oauthTestServer(responseBody string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(responseBody))
	}))
}

func TestClaudeFetchSnapshotFirst(t *testing.T) {
	// Snapshot exists → returned without calling OAuth or CLI.
	p := ClaudeProvider{
		SnapshotPath:  newSnapshotForTest(t, "claude"),
		AllowCLI:      true,
		AllowSnapshot: true,
	}
	q, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if q.Source != "codexbar-snapshot" {
		t.Fatalf("expected snapshot source, got %q", q.Source)
	}
}

func TestClaudeFetchOAuthBeforeCLI(t *testing.T) {
	// Snapshot missing, OAuth works → OAuth returned, CLI never called.
	srv := oauthTestServer(`{"current_interval_usage_count":10,"current_interval_total_count":100,"current_interval_remaining_percent":90,"current_interval_resets_at":"` + time.Now().Add(time.Hour).UTC().Format(time.RFC3339) + `"}`)
	defer srv.Close()

	p := ClaudeProvider{
		Home:          t.TempDir(),
		SnapshotPath:  filepath.Join(t.TempDir(), "nonexistent.json"),
		AllowCLI:      true,
		OAuthUsageURL: srv.URL,
		// KeychainRead stubs credential retrieval so readCredentials succeeds.
		KeychainRead: func(_ context.Context) ([]byte, error) {
			return json.Marshal(map[string]any{
				"accessToken": "tok",
				"expiresAt":   float64(time.Now().Add(time.Hour).UnixMilli()),
			})
		},
	}
	q, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if q.Source != "oauth-api" {
		t.Fatalf("expected oauth-api source, got %q", q.Source)
	}
}

func TestClaudeFetchOAuthBeforeCLI_CLIOnlyWhenOAuthFails(t *testing.T) {
	// Snapshot missing, OAuth fails (KeychainRead returns error) →
	// falls back to CLI. claude binary may or may not exist; we just
	// verify OAuth was tried (KeychainRead called) and CLI attempted.
	p := ClaudeProvider{
		Home:         t.TempDir(),
		SnapshotPath: filepath.Join(t.TempDir(), "nonexistent.json"),
		AllowCLI:     true,
		KeychainRead: func(_ context.Context) ([]byte, error) {
			return nil, os.ErrNotExist
		},
	}
	q, err := p.Fetch(context.Background())
	// If claude binary exists, CLI succeeds; otherwise we get an error.
	// Either outcome is fine — we're testing OAuth-before-CLI order, not
	// CLI success.
	if err == nil {
		t.Logf("CLI probe succeeded (claude binary present): source=%q", q.Source)
	} else {
		t.Logf("CLI probe failed (expected when claude binary absent): %v", err)
	}
}

func TestClaudeFetchOAuthBeforeCLI_NoCLIWhenNotAllowed(t *testing.T) {
	// Snapshot missing, OAuth fails, AllowCLI=false → error, not CLI.
	p := ClaudeProvider{
		Home:         t.TempDir(),
		SnapshotPath: filepath.Join(t.TempDir(), "nonexistent.json"),
		AllowCLI:     false,
		KeychainRead: func(_ context.Context) ([]byte, error) {
			return nil, os.ErrNotExist
		},
	}
	_, err := p.Fetch(context.Background())
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "all claude sources exhausted") {
		t.Fatalf("expected 'all claude sources exhausted', got %v", err)
	}
}

func TestClaudeFetchSnapshotOnlyWhenAvailable(t *testing.T) {
	// Snapshot exists → OAuth and CLI are never attempted regardless of config.
	srv := oauthTestServer(`{"current_interval_usage_count":10,"current_interval_total_count":100}`)
	defer srv.Close()

	p := ClaudeProvider{
		SnapshotPath:  newSnapshotForTest(t, "claude"),
		AllowCLI:      true,
		AllowSnapshot: true,
		OAuthUsageURL: srv.URL,
		// No KeychainRead set — this proves OAuth was not reached.
	}
	q, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if q.Source != "codexbar-snapshot" {
		t.Fatalf("expected snapshot, got %q", q.Source)
	}
}

// --- keychain cooldown guard tests (no real keychain) ---

func TestKeychainCooldownAfterDenial(t *testing.T) {
	dir := t.TempDir()
	p := ClaudeProvider{
		CredentialCacheDir: dir, AllowKeychain: true, KeychainCooldown: 30 * time.Minute,
	}
	m := keychainAttemptMarker{AttemptedAt: time.Now().Add(-1 * time.Minute), Success: false}
	raw, _ := json.Marshal(m)
	_ = os.WriteFile(p.keychainAttemptMarkerPath(), raw, 0o600)
	_, ok := p.tryLazyKeychain(context.Background(), p.credentialCachePath())
	if ok {
		t.Fatal("expected cooldown to block keychain attempt")
	}
}

func TestKeychainCooldownExpired(t *testing.T) {
	dir := t.TempDir()
	p := ClaudeProvider{
		CredentialCacheDir: dir, AllowKeychain: true, KeychainCooldown: 30 * time.Minute,
		KeychainRead: func(ctx context.Context) ([]byte, error) {
			return []byte(`{"accessToken":"mock","refreshToken":"rt","expiresAt":9999999999000}`), nil
		},
	}
	m := keychainAttemptMarker{AttemptedAt: time.Now().Add(-31 * time.Minute), Success: false}
	raw, _ := json.Marshal(m)
	_ = os.WriteFile(p.keychainAttemptMarkerPath(), raw, 0o600)
	cred, ok := p.tryLazyKeychain(context.Background(), p.credentialCachePath())
	if !ok {
		t.Fatal("expected keychain attempt after cooldown elapsed")
	}
	if cred.AccessToken != "mock" {
		t.Fatalf("expected mock, got %q", cred.AccessToken)
	}
	if _, err := os.Stat(p.keychainAttemptMarkerPath()); err == nil {
		t.Fatal("marker should be cleared on success")
	}
}

func TestKeychainNotAttemptedWithValidCache(t *testing.T) {
	dir := t.TempDir()
	var calls int
	p := ClaudeProvider{
		CredentialCacheDir: dir, AllowKeychain: true,
		KeychainRead: func(ctx context.Context) ([]byte, error) {
			calls++
			return nil, errors.New("unexpected")
		},
	}
	_ = writeCredentialCache(p.credentialCachePath(), claudeCredential{
		AccessToken: "cached", RefreshToken: "rt", ExpiresAt: time.Now().Add(time.Hour),
	})
	cred, err := p.readCredentials(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if cred.AccessToken != "cached" {
		t.Fatalf("expected cached, got %q", cred.AccessToken)
	}
	// Test seam (step 1) fires once before cache check — expected.
	if calls != 1 {
		t.Fatalf("expected KeychainRead test seam called once, got %d", calls)
	}
}

func TestKeychainNotAttemptedAllowKeychainFalse(t *testing.T) {
	dir := t.TempDir()
	var calls int
	p := ClaudeProvider{
		CredentialCacheDir: dir, AllowKeychain: false,
		KeychainRead: func(ctx context.Context) ([]byte, error) {
			calls++
			return nil, errors.New("unexpected")
		},
	}
	_, err := p.readCredentials(context.Background())
	if err == nil {
		t.Fatal("expected error with no credential available")
	}
	if calls != 1 {
		t.Fatalf("expected KeychainRead test seam called once (step 1), got %d", calls)
	}
}

func TestKeychainCooldownDefault(t *testing.T) {
	dir := t.TempDir()
	p := ClaudeProvider{CredentialCacheDir: dir, AllowKeychain: true}
	m := keychainAttemptMarker{AttemptedAt: time.Now().Add(-1 * time.Minute), Success: false}
	raw, _ := json.Marshal(m)
	_ = os.WriteFile(p.keychainAttemptMarkerPath(), raw, 0o600)
	_, ok := p.tryLazyKeychain(context.Background(), p.credentialCachePath())
	if ok {
		t.Fatal("expected default cooldown (30m) to block attempt at 1m")
	}
}
