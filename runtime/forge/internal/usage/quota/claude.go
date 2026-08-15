package quota

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

type ClaudeProvider struct {
	ProviderName       string
	Home               string
	AllowCLI           bool
	AllowKeychain      bool // lazy auto-acquire from Keychain (1 popup) — only in bg/usage, NEVER statusline
	Interactive        bool // deprecated; retained for backward-compat with existing tests
	AllowSnapshot      bool // opt-in: reads CodexBar group container (triggers macOS TCC popup)
	SnapshotPath       string
	Credentials        string
	CredentialCacheDir string
	Client             *http.Client
	// KeychainRead is a test seam. When set (non-nil) it is called
	// unconditionally, bypassing the Interactive gate. Production code
	// must never set this to a real keychain-calling function.
	KeychainRead          func(context.Context) ([]byte, error)
	OAuthUsageURL         string
	RefreshURL            string
	KeychainCooldown      time.Duration // min interval between keychain attempts (default 30m); exported for tests
	SnapshotStaleDuration time.Duration
}

func (p ClaudeProvider) Name() string {
	if strings.TrimSpace(p.ProviderName) != "" {
		return strings.TrimSpace(p.ProviderName)
	}
	return "claude-subscription"
}

func (p ClaudeProvider) Fetch(ctx context.Context) (Quota, error) {
	// CodexBar snapshot reads ~/Library/Group Containers/…/widget-snapshot.json
	// which triggers macOS TCC popup on every render. Keep it opt-in.
	if p.AllowSnapshot {
		if q, err := p.fetchSnapshot(); err == nil {
			return q, nil
		}
	}
	if q, err := p.fetchOAuth(ctx); err == nil {
		return q, nil
	}
	if p.AllowCLI {
		if q, err := p.fetchCLI(ctx); err == nil {
			return q, nil
		}
	}
	return Quota{}, errors.New("all claude sources exhausted (empty cache; keychain auto-acquire will fire on next attempt)")
}

func (p ClaudeProvider) fetchSnapshot() (Quota, error) {
	path := p.SnapshotPath
	if path == "" {
		path = filepath.Join(homeOr(p.Home), "Library", "Group Containers", "Y5PE65HELJ.com.steipete.codexbar", "widget-snapshot.json")
	}
	st, err := os.Stat(path)
	if err != nil {
		return Quota{}, err
	}
	staleLimit := p.SnapshotStaleDuration
	if staleLimit <= 0 {
		staleLimit = 15 * time.Minute
	}
	if time.Since(st.ModTime()) > staleLimit {
		return Quota{}, errors.New("codexbar snapshot stale")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return Quota{}, err
	}
	q, err := parseSnapshotEntry(raw, "claude")
	if err != nil {
		return Quota{}, err
	}
	q.Provider = p.Name()
	q.Source = "codexbar-snapshot"
	q.FetchedAt = st.ModTime()
	return q, nil
}

func (p ClaudeProvider) fetchCLI(ctx context.Context) (Quota, error) {
	if runtime.GOOS == "windows" {
		return Quota{}, errors.New("claude cli pty source unavailable on windows")
	}
	cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, "claude", "--allowed-tools", "")
	cmd.Stdin = strings.NewReader("/usage\n")
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Run(); err != nil {
		return Quota{}, err
	}
	q, err := ParseClaudeCLIPanel(out.String())
	if err != nil {
		return Quota{}, err
	}
	q.Provider = p.Name()
	q.Source = "claude-cli"
	q.FetchedAt = time.Now()
	return q, nil
}

func (p ClaudeProvider) fetchOAuth(ctx context.Context) (Quota, error) {
	cred, err := p.readCredentials(ctx)
	if err != nil {
		return Quota{}, err
	}
	if cred.AccessToken == "" {
		return Quota{}, errors.New("claude oauth token unavailable")
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
		return Quota{}, err
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
		return Quota{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return Quota{}, errors.New(resp.Status)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return Quota{}, err
	}
	q, err := ParseClaudeOAuthUsage(body)
	if err != nil {
		return Quota{}, err
	}
	q.Provider = p.Name()
	q.Source = "oauth-api"
	q.FetchedAt = time.Now()
	return q, nil
}

type claudeCredential struct {
	AccessToken  string
	RefreshToken string
	ExpiresAt    time.Time
}

func (p ClaudeProvider) readCredentials(ctx context.Context) (claudeCredential, error) {
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
	// Statusline render sets AllowKeychain=false and NEVER triggers a popup.
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

// --- keychain cooldown / popup-storm guard ---

func (p ClaudeProvider) keychainAttemptMarkerPath() string {
	return strings.TrimSuffix(p.credentialCachePath(), ".json") + "-keychain-attempt.json"
}

type keychainAttemptMarker struct {
	AttemptedAt time.Time `json:"attempted_at"`
	Success     bool      `json:"success"`
}

func (p ClaudeProvider) readKeychainAttemptMarker() (keychainAttemptMarker, bool) {
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

func (p ClaudeProvider) writeKeychainAttemptMarker(m keychainAttemptMarker) {
	raw, _ := json.Marshal(m)
	_ = SafeAtomicWrite(p.keychainAttemptMarkerPath(), raw, 0o600)
}

func (p ClaudeProvider) clearKeychainAttemptMarker() {
	_ = os.Remove(p.keychainAttemptMarkerPath())
}

func (p ClaudeProvider) doKeychainRead(ctx context.Context) ([]byte, error) {
	if p.KeychainRead != nil {
		return p.KeychainRead(ctx)
	}
	return readClaudeKeychain(ctx)
}

// tryLazyKeychain attempts a keychain read with cooldown gating.
func (p ClaudeProvider) tryLazyKeychain(ctx context.Context, credCachePath string) (claudeCredential, bool) {
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

func (p ClaudeProvider) credentialCachePath() string {
	dir := p.CredentialCacheDir
	if dir == "" {
		dir = filepath.Join(homeOr(p.Home), ".local", "share", "forge", "quota")
	}
	return filepath.Join(dir, "claude-credential.json")
}

func (p ClaudeProvider) refreshToken(ctx context.Context, refreshToken string) (claudeCredential, error) {
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

// parseSnapshotEntry parses the CodexBar widget-snapshot.json, supporting both
// v2 (entries[] array filtered by provider field) and v1 (root primary/secondary
// as fallback for claude).
func parseSnapshotEntry(raw []byte, provider string) (Quota, error) {
	var root map[string]any
	if err := json.Unmarshal(raw, &root); err != nil {
		return Quota{}, err
	}

	// v2 format: entries[] array
	if entries, ok := root["entries"].([]any); ok {
		for _, entry := range entries {
			m, ok := entry.(map[string]any)
			if !ok {
				continue
			}
			if toString(m["provider"]) != provider {
				continue
			}
			windows := []Window{}
			if w, ok := parseSnapshotWindow(m["primary"]); ok {
				windows = append(windows, w)
			}
			if w, ok := parseSnapshotWindow(m["secondary"]); ok {
				windows = append(windows, w)
			}
			if len(windows) == 0 {
				return Quota{}, errors.New("snapshot windows unavailable")
			}
			return Quota{Windows: windows}, nil
		}
		return Quota{}, errors.New("provider not found in snapshot entries")
	}

	// v1 fallback: root primary/secondary (claude only)
	if provider == "claude" {
		windows := []Window{}
		if w, ok := parseSnapshotWindow(root["primary"]); ok {
			windows = append(windows, w)
		}
		if w, ok := parseSnapshotWindow(root["secondary"]); ok {
			windows = append(windows, w)
		}
		if len(windows) == 0 {
			return Quota{}, errors.New("snapshot windows unavailable")
		}
		return Quota{Windows: windows}, nil
	}

	return Quota{}, errors.New("snapshot format unsupported")
}

// parseSnapshotWindow parses a single window object from a snapshot entry,
// deriving the window name from windowMinutes.
func parseSnapshotWindow(value any) (Window, bool) {
	m, ok := value.(map[string]any)
	if !ok {
		return Window{}, false
	}
	var pct float64
	if n, ok := coerceFloat(firstPresent(m, "usedPercent", "used_percent", "utilization", "usage_percentage", "percentage", "pct")); ok {
		pct = n
	} else if remaining, ok := coerceFloat(firstPresent(m, "remainingPercent", "remaining_percent")); ok {
		pct = 100 - remaining
	} else {
		return Window{}, false
	}
	wm, _ := coerceFloat(firstPresent(m, "windowMinutes", "window_minutes"))
	minutes := int(wm)
	if minutes == 0 {
		// fallback for entries without explicit windowMinutes
		minutes = 300
	}
	w := Window{Name: windowName(minutes), Pct: pct, WindowMinutes: minutes}
	if reset := parseTimeAny(firstPresent(m, "resetsAt", "reset_at", "resets_at")); reset != nil {
		w.ResetsAt = reset
	}
	return w, true
}

// windowName returns a human-readable name for a window duration in minutes.
func windowName(minutes int) string {
	switch minutes {
	case 300:
		return "5h"
	case 10080:
		return "7d"
	default:
		if minutes >= 1440 && minutes%1440 == 0 {
			return fmt.Sprintf("%dd", minutes/1440)
		}
		if minutes >= 60 && minutes%60 == 0 {
			return fmt.Sprintf("%dh", minutes/60)
		}
		return fmt.Sprintf("%dm", minutes)
	}
}

func ParseClaudeOAuthUsage(raw []byte) (Quota, error) {
	var root map[string]any
	if err := json.Unmarshal(raw, &root); err != nil {
		return Quota{}, err
	}
	windows := []Window{}
	if w, ok := parseCurrentClaudeWindow(root, "current_interval", "5h", 300); ok {
		windows = append(windows, w)
	}
	if w, ok := parseCurrentClaudeWindow(root, "current_weekly", "7d", 10080); ok {
		windows = append(windows, w)
	}
	if len(windows) == 0 {
		if w, ok := parseClaudeWindow(root["five_hour"], "5h", 300); ok {
			windows = append(windows, w)
		}
		if w, ok := parseClaudeWindow(root["seven_day"], "7d", 10080); ok {
			windows = append(windows, w)
		}
	}
	if len(windows) == 0 {
		return Quota{}, errors.New("claude oauth windows unavailable")
	}
	return Quota{Windows: windows}, nil
}

func ParseClaudeCLIPanel(text string) (Quota, error) {
	windows := []Window{}
	for _, spec := range []struct {
		name    string
		minutes int
		re      *regexp.Regexp
	}{
		{"5h", 300, regexp.MustCompile(`(?i)(?:5\s*h|session|current).*?(\d+(?:\.\d+)?)\s*%`)},
		{"7d", 10080, regexp.MustCompile(`(?i)(?:7\s*d|weekly|week).*?(\d+(?:\.\d+)?)\s*%`)},
	} {
		if m := spec.re.FindStringSubmatch(text); len(m) > 1 {
			if n, ok := coerceFloat(m[1]); ok {
				windows = append(windows, Window{Name: spec.name, Pct: n, WindowMinutes: spec.minutes})
			}
		}
	}
	if len(windows) == 0 {
		return Quota{}, errors.New("claude cli usage panel unparsable")
	}
	return Quota{Windows: windows}, nil
}

func parseCurrentClaudeWindow(root map[string]any, prefix, name string, minutes int) (Window, bool) {
	total, _ := coerceFloat(root[prefix+"_total_count"])
	used, _ := coerceFloat(root[prefix+"_usage_count"])
	remainingPct, hasRemainingPct := coerceFloat(root[prefix+"_remaining_percent"])
	var pct float64
	switch {
	case total > 0:
		pct = used / total * 100
	case hasRemainingPct:
		pct = 100 - remainingPct
	default:
		return Window{}, false
	}
	w := Window{Name: name, Pct: pct, WindowMinutes: minutes}
	if reset := parseTimeAny(firstPresent(root, prefix+"_reset_at", prefix+"_resets_at", "reset_at", "resets_at")); reset != nil {
		w.ResetsAt = reset
	}
	if wm, ok := coerceFloat(firstPresent(root, prefix+"_window_minutes", prefix+"_windowMinutes", "window_minutes", "windowMinutes")); ok {
		w.WindowMinutes = int(wm)
	}
	return w, true
}

func parseClaudeWindow(value any, name string, minutes int) (Window, bool) {
	m, ok := value.(map[string]any)
	if !ok {
		return Window{}, false
	}
	var pct float64
	if n, ok := coerceFloat(firstPresent(m, "usedPercent", "used_percent", "utilization", "usage_percentage", "percentage", "pct")); ok {
		pct = n
	} else if remaining, ok := coerceFloat(firstPresent(m, "remainingPercent", "remaining_percent", "current_interval_remaining_percent")); ok {
		pct = 100 - remaining
	} else {
		return Window{}, false
	}
	w := Window{Name: name, Pct: pct, WindowMinutes: minutes}
	if reset := parseTimeAny(firstPresent(m, "reset_at", "resets_at", "resetsAt")); reset != nil {
		w.ResetsAt = reset
	}
	if wm, ok := coerceFloat(firstPresent(m, "window_minutes", "windowMinutes")); ok {
		w.WindowMinutes = int(wm)
	}
	return w, true
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

// ClaudeCredential holds parsed Anthropic OAuth credential fields.
// Exported for use by the forge auth bootstrap commands.
type ClaudeCredential struct {
	AccessToken  string
	RefreshToken string
	ExpiresAt    time.Time
}

// ParseClaudeCredentialJSON parses a JSON blob containing an Anthropic
// OAuth credential. Handles both flat {accessToken, refreshToken, expiresAt}
// and nested {claudeAiOauth: {...}} shapes. expiresAt is expected as
// milliseconds since epoch.
func ParseClaudeCredentialJSON(raw []byte) ClaudeCredential {
	cred := parseClaudeCredential(raw)
	return ClaudeCredential{
		AccessToken:  cred.AccessToken,
		RefreshToken: cred.RefreshToken,
		ExpiresAt:    cred.ExpiresAt,
	}
}

func parseTimeAny(v any) *time.Time {
	s := toString(v)
	if s == "" {
		return nil
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02 15:04:05"} {
		if t, err := time.Parse(layout, s); err == nil {
			return &t
		}
	}
	return nil
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
