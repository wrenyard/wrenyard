package quota

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

type credentialCache struct {
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token"`
	ExpiresAt    time.Time `json:"expires_at"`
	CachedAt     time.Time `json:"cached_at"`
}

func readCredentialCache(path string) (claudeCredential, bool) {
	if path == "" {
		return claudeCredential{}, false
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return claudeCredential{}, false
	}
	var cc credentialCache
	if err := json.Unmarshal(raw, &cc); err != nil {
		return claudeCredential{}, false
	}
	if cc.AccessToken == "" {
		return claudeCredential{}, false
	}
	return claudeCredential{
		AccessToken:  cc.AccessToken,
		RefreshToken: cc.RefreshToken,
		ExpiresAt:    cc.ExpiresAt,
	}, true
}

func writeCredentialCache(path string, cred claudeCredential) error {
	if path == "" {
		return errors.New("empty credential cache path")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	cc := credentialCache{
		AccessToken:  cred.AccessToken,
		RefreshToken: cred.RefreshToken,
		ExpiresAt:    cred.ExpiresAt,
		CachedAt:     time.Now(),
	}
	raw, err := json.Marshal(cc)
	if err != nil {
		return err
	}
	// H3: Use safe atomic write with unique temp file to prevent symlink/loose-perm leaks.
	return safeAtomicWrite(path, raw, 0o600)
}

// safeAtomicWrite writes data to a file atomically using a uniquely-named temp
// file in the target directory. H3: prevents symlink attacks and pre-existing
// loose-permission files from leaking secrets.
func safeAtomicWrite(target string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(target)
	// Check that the target path does not resolve through a symlink.
	if fi, err := os.Lstat(target); err == nil {
		if fi.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("refusing to write through symlink: %s", target)
		}
	}
	tmp, err := os.CreateTemp(dir, filepath.Base(target)+".*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	// Best-effort cleanup: remove tmpName if any later step fails,
	// including final rename failure. On successful rename tmpName
	// no longer exists and deferred os.Remove is a no-op (error ignored).
	defer os.Remove(tmpName)
	// Set strict permissions.
	if err := tmp.Chmod(perm); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	return os.Rename(tmpName, target)
}

// SafeAtomicWrite is the exported wrapper around safeAtomicWrite.
func SafeAtomicWrite(target string, data []byte, perm os.FileMode) error {
	return safeAtomicWrite(target, data, perm)
}

// WriteClaudeCredentialCache writes a claude OAuth credential to the
// disk cache at path. Exported for use by the forge auth bootstrap
// command (forge auth claude-token).
func WriteClaudeCredentialCache(path string, accessToken, refreshToken string, expiresAt time.Time) error {
	return writeCredentialCache(path, claudeCredential{
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		ExpiresAt:    expiresAt,
	})
}
