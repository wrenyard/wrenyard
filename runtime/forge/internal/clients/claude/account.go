package claude

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/clients/account"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/lifecycle/layout"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type RawObservation = account.Observation
type Client struct {
	Home               string
	AllowKeychain      bool // gated by the client caller
	AllowSnapshot      bool // opt-in: reads CodexBar group container (triggers macOS TCC popup)
	SnapshotPath       string
	Credentials        string
	CredentialCacheDir string
	Client             *http.Client
	// KeychainRead is a test seam. When set (non-nil) it is called
	// unconditionally, bypassing the AllowKeychain gate. Production code
	// must never set this to a real keychain-calling function.
	KeychainRead          func(context.Context) ([]byte, error)
	OAuthUsageURL         string
	RefreshURL            string
	KeychainCooldown      time.Duration // min interval between keychain attempts (default 30m); exported for tests
	SnapshotStaleDuration time.Duration
}

type claudeCredential struct {
	AccessToken  string
	RefreshToken string
	ExpiresAt    time.Time
}
type ClaudeCredential = claudeCredential
type keychainAttemptMarker struct {
	AttemptedAt time.Time `json:"attempted_at"`
	Success     bool      `json:"success"`
}

func (p Client) ReadUsage(ctx context.Context) (RawObservation, error) {
	if p.AllowSnapshot {
		path := p.SnapshotPath
		if path == "" {
			path = filepath.Join(homeOr(p.Home), "Library", "Group Containers", "Y5PE65HELJ.com.steipete.codexbar", "widget-snapshot.json")
		}
		stale := p.SnapshotStaleDuration
		if stale <= 0 {
			stale = 15 * time.Minute
		}
		if stat, err := os.Stat(path); err == nil && time.Since(stat.ModTime()) <= stale {
			if data, err := os.ReadFile(path); err == nil && json.Valid(data) {
				// Source selection and fallback are owned by the TS quota service.
				payload := map[string]any{"snapshot": json.RawMessage(data), "snapshot_at": stat.ModTime()}
				raw, err := json.Marshal(payload)
				return RawObservation{Source: "claude-sources", FetchedAt: time.Now(), Data: raw}, err
			}
		}
	}
	return p.readOAuth(ctx)
}

func (p Client) readOAuth(ctx context.Context) (RawObservation, error) {
	cred, err := p.readCredentials(ctx)
	if err != nil {
		return RawObservation{}, err
	}
	if cred.AccessToken == "" {
		return RawObservation{}, errors.New("claude oauth token unavailable")
	}
	credCachePath := p.credentialCachePath()
	if cred.ExpiresAt.After(time.Now()) || cred.ExpiresAt.IsZero() {
		// ok
	} else if cred.RefreshToken != "" {
		if refreshed, err := p.refreshToken(ctx, cred.RefreshToken); err == nil && refreshed.AccessToken != "" {
			cred = refreshed
			_ = writeCredentialCache(credCachePath, cred) // H4: persist refreshed token
		}
	}
	url := p.OAuthUsageURL
	if url == "" {
		url = "https://api.anthropic.com/api/oauth/usage"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return RawObservation{}, err
	}
	req.Header.Set("Authorization", "Bearer "+cred.AccessToken)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("anthropic-beta", "oauth-2025-04-20")
	req.Header.Set("anthropic-version", "2023-06-01")
	client := p.Client
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return RawObservation{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return RawObservation{}, errors.New(resp.Status)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return RawObservation{}, err
	}
	return RawObservation{Source: "oauth-api", FetchedAt: time.Now(), Data: json.RawMessage(body)}, nil
}

func (p Client) readCredentials(ctx context.Context) (claudeCredential, error) {
	credCachePath := p.credentialCachePath()

	// 1. KeychainRead callback (used by tests). Runs unconditionally
	// before the cache check so tests can seed the provider directly.
	if p.KeychainRead != nil {
		if raw, err := p.KeychainRead(ctx); err == nil {
			if cred := parseClaudeCredential(raw); cred.AccessToken != "" {
				_ = writeCredentialCache(credCachePath, cred)
				p.clearKeychainAttemptMarker()
				return cred, nil
			}
		}
	}

	// 2. Credential disk cache, if access token not expired (60s safety margin)
	var cachedCred claudeCredential
	var hasCachedCred bool
	if cached, ok := readCredentialCache(credCachePath); ok {
		hasCachedCred = true
		if cached.ExpiresAt.IsZero() || time.Until(cached.ExpiresAt) > 60*time.Second {
			return cached, nil
		}
		// 3. Cached token expired but refresh token present: refresh
		if cached.RefreshToken != "" {
			if refreshed, err := p.refreshToken(ctx, cached.RefreshToken); err == nil && refreshed.AccessToken != "" {
				_ = writeCredentialCache(credCachePath, refreshed)
				return refreshed, nil
			}
		}
		cachedCred = cached
	}

	// 4. Lazy keychain auto-acquisition — only when AllowKeychain is true.
	// Callers that disable keychain access never trigger a popup.
	if p.AllowKeychain {
		if cred, ok := p.tryLazyKeychain(ctx, credCachePath); ok {
			return cred, nil
		}
	}

	// 5. ~/.claude/.credentials.json file (existing fallback)
	path := p.Credentials
	if path == "" {
		path = filepath.Join(homeOr(p.Home), ".claude", ".credentials.json")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if hasCachedCred {
			return cachedCred, nil
		}
		return claudeCredential{}, errors.New("cannot read claude credentials file")
	}
	cred := parseClaudeCredential(raw)
	if cred.AccessToken == "" {
		if hasCachedCred {
			return cachedCred, nil
		}
		return claudeCredential{}, errors.New("credentials missing accessToken")
	}
	_ = writeCredentialCache(credCachePath, cred)
	return cred, nil
}

func (p Client) keychainAttemptMarkerPath() string {
	return strings.TrimSuffix(p.credentialCachePath(), ".json") + "-keychain-attempt.json"
}

func (p Client) readKeychainAttemptMarker() (keychainAttemptMarker, bool) {
	raw, err := os.ReadFile(p.keychainAttemptMarkerPath())
	if err != nil {
		return keychainAttemptMarker{}, false
	}
	var m keychainAttemptMarker
	if err := json.Unmarshal(raw, &m); err != nil {
		return keychainAttemptMarker{}, false
	}
	return m, true
}

func (p Client) writeKeychainAttemptMarker(m keychainAttemptMarker) {
	raw, _ := json.Marshal(m)
	_ = safeAtomicWrite(p.keychainAttemptMarkerPath(), raw, 0o600)
}

func (p Client) clearKeychainAttemptMarker() {
	_ = os.Remove(p.keychainAttemptMarkerPath())
}

func (p Client) doKeychainRead(ctx context.Context) ([]byte, error) {
	if p.KeychainRead != nil {
		return p.KeychainRead(ctx)
	}
	return readClaudeKeychain(ctx)
}

func (p Client) tryLazyKeychain(ctx context.Context, credCachePath string) (claudeCredential, bool) {
	// Check cooldown.
	if m, ok := p.readKeychainAttemptMarker(); ok {
		cooldown := p.KeychainCooldown
		if cooldown <= 0 {
			cooldown = 30 * time.Minute
		}
		if time.Since(m.AttemptedAt) < cooldown {
			return claudeCredential{}, false
		}
	}

	raw, err := p.doKeychainRead(ctx)
	p.writeKeychainAttemptMarker(keychainAttemptMarker{
		AttemptedAt: time.Now(),
		Success:     err == nil,
	})
	if err != nil {
		return claudeCredential{}, false
	}
	cred := parseClaudeCredential(raw)
	if cred.AccessToken == "" {
		return claudeCredential{}, false
	}
	_ = writeCredentialCache(credCachePath, cred)
	p.clearKeychainAttemptMarker()
	return cred, true
}

func (p Client) credentialCachePath() string {
	dir := p.CredentialCacheDir
	if dir == "" {
		dir = filepath.Join(layout.NewPaths(homeOr(p.Home)).DataDir(), "quota")
	}
	return filepath.Join(dir, "claude-credential.json")
}

func (p Client) refreshToken(ctx context.Context, refreshToken string) (claudeCredential, error) {
	endpoint := p.RefreshURL
	if endpoint == "" {
		endpoint = "https://platform.claude.com/v1/oauth/token"
	}
	body := strings.NewReader("grant_type=refresh_token&refresh_token=" + url.QueryEscape(refreshToken))
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, body)
	if err != nil {
		return claudeCredential{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	client := p.Client
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return claudeCredential{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return claudeCredential{}, errors.New(resp.Status)
	}
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return claudeCredential{}, err
	}
	cred := parseClaudeCredential(raw)
	// H4: Many providers omit refresh_token on refresh. Preserve the prior token.
	if cred.RefreshToken == "" {
		cred.RefreshToken = refreshToken
	}
	return cred, nil
}

func parseClaudeCredential(raw []byte) claudeCredential {
	var root map[string]any
	if err := json.Unmarshal(raw, &root); err != nil {
		return claudeCredential{}
	}
	if nested, ok := root["claudeAiOauth"].(map[string]any); ok {
		root = nested
	}
	if root["accessToken"] == nil {
		for _, v := range root {
			if nested, ok := v.(map[string]any); ok && nested["accessToken"] != nil {
				root = nested
				break
			}
		}
	}
	cred := claudeCredential{
		AccessToken:  toString(root["accessToken"]),
		RefreshToken: toString(root["refreshToken"]),
	}
	if ms, ok := coerceFloat(firstPresent(root, "expiresAt", "expires_at")); ok && ms > 0 {
		cred.ExpiresAt = time.UnixMilli(int64(ms))
	}
	return cred
}

func ParseClaudeCredentialJSON(raw []byte) ClaudeCredential {
	cred := parseClaudeCredential(raw)
	return ClaudeCredential{
		AccessToken:  cred.AccessToken,
		RefreshToken: cred.RefreshToken,
		ExpiresAt:    cred.ExpiresAt,
	}
}

func firstPresent(m map[string]any, keys ...string) any {
	for _, key := range keys {
		if v, ok := m[key]; ok && v != nil {
			return v
		}
	}
	return nil
}

func homeOr(home string) string {
	if home != "" {
		return home
	}
	h, _ := os.UserHomeDir()
	return h
}
