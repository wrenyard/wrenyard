package auth

import (
	"context"
	"fmt"
	"io"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/usage/quota"
	"golang.org/x/term"
)

// CommandDeps is the explicit dependency bundle for provider auth operations.
type CommandDeps struct {
	StoreRead        func(path string) (map[string]Entry, error)
	StoreWrite       func(path string, entries map[string]Entry) error
	StorePath        string
	KnownProviderIDs func() []string
	ProviderConfig   func(id string) (ProviderCfg, bool)
	DataDir          string
	Stdin            io.Reader
	Stdout           io.Writer
	Stderr           io.Writer
	IsTerminal       func(fd int) bool
	StdinFd          int
	QuotaVerify      func(stderr io.Writer, key string)
}

type ProviderCfg struct {
	Name    string
	APIKind string
	BaseURL string
}

// Login runs interactive API key entry for a given canonical provider ID.
// It is the production implementation used by the providers auth login flow.
func Login(deps CommandDeps, providerID string) error {
	providerID = strings.TrimSpace(providerID)
	if providerID == "" {
		return fmt.Errorf("auth login: provider id is required")
	}
	if !knownProvider(deps, providerID) {
		return fmt.Errorf("auth login: provider %q does not support Forge-managed API-key login", providerID)
	}
	if deps.IsTerminal == nil || !deps.IsTerminal(deps.StdinFd) {
		return fmt.Errorf("auth login: interactive login requires a TTY")
	}

	fmt.Fprint(deps.Stderr, "API key: ")
	keyBytes, err := term.ReadPassword(deps.StdinFd)
	fmt.Fprintln(deps.Stderr)
	if err != nil {
		return fmt.Errorf("auth login: read key: %v", err)
	}
	key := strings.TrimSpace(string(keyBytes))
	if key == "" {
		return fmt.Errorf("auth login: key must not be empty")
	}

	auth, err := deps.StoreRead(deps.StorePath)
	if err != nil {
		return fmt.Errorf("auth login: %v", err)
	}
	auth[providerID] = Entry{Type: "api", Key: key}
	if err := deps.StoreWrite(deps.StorePath, auth); err != nil {
		return fmt.Errorf("auth login: write auth: %v", err)
	}

	fmt.Fprintf(deps.Stdout, "Saved credential for %s (key: %s)\n", providerID, MaskKey(key))

	if deps.QuotaVerify != nil {
		if pc, ok := deps.ProviderConfig(providerID); ok {
			if pc.APIKind == "anthropic" && strings.HasPrefix(pc.BaseURL, "https://open.bigmodel.cn") {
				deps.QuotaVerify(deps.Stderr, key)
			}
		}
	}

	return nil
}

// Logout removes a saved credential for a given canonical provider ID.
// It is the production implementation used by the providers auth logout flow.
func Logout(deps CommandDeps, providerID string) error {
	providerID = strings.TrimSpace(providerID)
	if providerID == "" {
		return fmt.Errorf("auth logout: provider id is required")
	}

	auth, err := deps.StoreRead(deps.StorePath)
	if err != nil {
		return fmt.Errorf("auth logout: %v", err)
	}
	if _, exists := auth[providerID]; !exists {
		return fmt.Errorf("auth logout: no credential saved for %s", providerID)
	}

	delete(auth, providerID)
	if err := deps.StoreWrite(deps.StorePath, auth); err != nil {
		return fmt.Errorf("auth logout: write auth: %v", err)
	}
	fmt.Fprintf(deps.Stdout, "Removed credential for %s\n", providerID)
	return nil
}

// List lists configured credentials for display.
func List(deps CommandDeps) error {
	auth, err := deps.StoreRead(deps.StorePath)
	if err != nil {
		return fmt.Errorf("auth: %v", err)
	}
	if len(auth) == 0 {
		fmt.Fprintln(deps.Stdout, "No credentials configured.")
		return nil
	}
	ids := make([]string, 0, len(auth))
	for id := range auth {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	fmt.Fprintf(deps.Stdout, "%-30s %-8s %s\n", "PROVIDER", "TYPE", "KEY")
	for _, id := range ids {
		entry := auth[id]
		masked := ""
		if entry.Key != "" {
			masked = MaskKey(entry.Key)
		} else if entry.Access != "" {
			masked = MaskKey(entry.Access)
		}
		fmt.Fprintf(deps.Stdout, "%-30s %-8s %s\n", id, entry.Type, masked)
	}
	return nil
}

// PrintHelp writes the auth help text to w.
func PrintHelp(w io.Writer) {
	fmt.Fprint(w, `forge auth — Manage provider credentials

FLAGS
  --yes                 Skip confirmation prompts
  --key-stdin           Read API key from stdin (non-interactive)

COMMANDS
  forge auth login <provider-id>
    Interactive API key entry for a Forge-managed provider.

  forge auth set <provider-id> --key-stdin
    Set provider credential from stdin (for scripting).
    Example: printf '<api-key>' | forge auth set kimi-coding --key-stdin

  forge auth list
    List configured providers with type and masked key tail.

  forge auth logout <provider-id>
    Remove saved credential for a provider.

  forge auth claude-token
    Optional: manually store an OAuth token from stdin (e.g. from
    'claude setup-token'). Not required — auto-acquisition from Keychain
    is the default. Example: printf '<token>' | forge auth claude-token

EXAMPLES
  # Interactive login
  forge auth login kimi-coding

  # List credentials (never shows full keys)
  forge auth list
`)
}

// The following are kept for internal migration/storage helpers:

// Set sets a provider credential from stdin (scripting). Kept for internal use.
func Set(deps CommandDeps, args []string) int {
	var providerID string
	keyStdin := false
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--key-stdin":
			keyStdin = true
		default:
			if !strings.HasPrefix(args[i], "-") && providerID == "" {
				providerID = args[i]
			} else {
				fmt.Fprintf(deps.Stderr, "forge auth set: unknown argument %s\n", args[i])
				return 2
			}
		}
	}
	if !keyStdin {
		fmt.Fprintln(deps.Stderr, "forge auth set: --key-stdin is required. Reads API key from stdin.")
		fmt.Fprintln(deps.Stderr, "Usage: printf '<key>' | forge auth set <provider-id> --key-stdin")
		return 2
	}
	if providerID == "" {
		fmt.Fprintln(deps.Stderr, "forge auth set: provider id is required")
		return 2
	}
	if !knownProvider(deps, providerID) {
		fmt.Fprintf(deps.Stderr, "forge auth set: provider %q does not support Forge-managed API-key login\n", providerID)
		return 2
	}
	keyBytes, err := io.ReadAll(deps.Stdin)
	if err != nil {
		fmt.Fprintf(deps.Stderr, "forge auth set: read stdin: %v\n", err)
		return 1
	}
	key := strings.TrimSpace(string(keyBytes))
	if key == "" {
		fmt.Fprintln(deps.Stderr, "forge auth set: key must not be empty")
		return 1
	}
	auth, err := deps.StoreRead(deps.StorePath)
	if err != nil {
		fmt.Fprintf(deps.Stderr, "forge auth set: %v\n", err)
		return 1
	}
	auth[providerID] = Entry{Type: "api", Key: key}
	if err := deps.StoreWrite(deps.StorePath, auth); err != nil {
		fmt.Fprintf(deps.Stderr, "forge auth set: write auth: %v\n", err)
		return 1
	}
	fmt.Fprintf(deps.Stdout, "Saved credential for %s (key: %s)\n", providerID, MaskKey(key))
	return 0
}

func knownProvider(deps CommandDeps, providerID string) bool {
	if deps.KnownProviderIDs == nil {
		return false
	}
	for _, id := range deps.KnownProviderIDs() {
		if id == providerID {
			return true
		}
	}
	return false
}

// ClaudeToken stores a Claude OAuth token from stdin. Kept for internal use.
func ClaudeToken(deps CommandDeps, args []string) int {
	_ = args
	input, err := io.ReadAll(deps.Stdin)
	if err != nil {
		fmt.Fprintf(deps.Stderr, "forge auth claude-token: read stdin: %v\n", err)
		return 1
	}
	token := strings.TrimSpace(string(input))
	if token == "" {
		fmt.Fprintln(deps.Stderr, "forge auth claude-token: token must not be empty")
		fmt.Fprintln(deps.Stderr, "Usage: printf '<accessToken>' | forge auth claude-token")
		return 1
	}
	var accessToken, refreshToken string
	var expiresAt time.Time
	if strings.HasPrefix(token, "{") {
		if cred := quota.ParseClaudeCredentialJSON([]byte(token)); cred.AccessToken != "" {
			accessToken = cred.AccessToken
			refreshToken = cred.RefreshToken
			expiresAt = cred.ExpiresAt
		}
	}
	if accessToken == "" {
		accessToken = token
	}
	cachePath := filepath.Join(deps.DataDir, "quota", "claude-credential.json")
	if err := quota.WriteClaudeCredentialCache(cachePath, accessToken, refreshToken, expiresAt); err != nil {
		fmt.Fprintf(deps.Stderr, "forge auth claude-token: write credential: %v\n", err)
		return 1
	}
	fmt.Fprintf(deps.Stdout, "Claude OAuth token saved to %s\n", cachePath)
	return 0
}

// MaskKey redacts an API key for display.
func MaskKey(key string) string {
	if len(key) <= 4 {
		return "****"
	}
	return "..." + key[len(key)-4:]
}

// VerifyQuota validates a BigModel key via a short-lived fetch.
func VerifyQuota(stderr io.Writer, key string) {
	fmt.Fprint(stderr, "Verifying API key... ")
	provider := quota.BigModelProvider{Token: key}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	q, err := provider.Fetch(ctx)
	if err != nil {
		fmt.Fprintf(stderr, "failed: %v\n", err)
	} else {
		fmt.Fprintf(stderr, "ok (quota available)\n")
		_ = q
	}
}
