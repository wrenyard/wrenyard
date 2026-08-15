package claudeapp

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func statePath() (string, error) {
	if isWindows() {
		if base := os.Getenv("LOCALAPPDATA"); base != "" {
			return filepath.Join(base, "Forge", stateFileName), nil
		}
	}
	if base := os.Getenv("XDG_STATE_HOME"); base != "" {
		return filepath.Join(base, "forge", stateFileName), nil
	}
	home := userHome()
	if home == "" {
		return "", errors.New("forge app: cannot locate home directory for local state")
	}
	return filepath.Join(home, ".local", "state", "forge", stateFileName), nil
}

// ReadOrCreateState returns the current state and the path it should be written
// to. It generates a gateway API key in memory when missing but does NOT persist
// the file; callers must explicitly WriteState to persist.
func ReadOrCreateState() (State, string, error) {
	path, err := statePath()
	if err != nil {
		return State{}, "", err
	}
	state := State{}
	if content, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(content, &state)
	}
	if state.GatewayAPIKey == "" {
		key, err := newGatewayKey()
		if err != nil {
			return State{}, "", err
		}
		state.GatewayAPIKey = key
	}
	return state, path, nil
}

func WriteState(path string, state State) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	content, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(content, '\n'), 0o600)
}

func newGatewayKey() (string, error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return "forge_" + hex.EncodeToString(buf), nil
}

// GatewayMatches reports whether the gateway at baseURL is healthy and serving
// the given profile/provider.
func GatewayMatches(cfg Config) (bool, error) {
	status, err := ReadGatewayStatus(cfg.GatewayBaseURL)
	if err != nil {
		return false, err
	}
	if status["status"] != "ok" {
		return false, nil
	}
	if status["profile"] != cfg.Profile.Name {
		return false, nil
	}
	if status["provider"] != cfg.Profile.Provider {
		return false, nil
	}
	return true, nil
}

func ReadGatewayStatus(baseURL string) (map[string]string, error) {
	client := http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(strings.TrimRight(baseURL, "/") + "/health")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("gateway health returned %s", resp.Status)
	}
	payload := map[string]interface{}{}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, err
	}
	status := map[string]string{}
	for key, value := range payload {
		if text, ok := value.(string); ok {
			status[key] = text
		}
	}
	return status, nil
}

func userHome() string {
	for _, key := range []string{"HOME", "USERPROFILE"} {
		if home := strings.TrimSpace(os.Getenv(key)); home != "" {
			return home
		}
	}
	home, _ := os.UserHomeDir()
	return home
}

func GatewayHealthy(baseURL string) bool {
	status, err := ReadGatewayStatus(baseURL)
	return err == nil && status["status"] == "ok" && status["profile"] != "" && status["provider"] != ""
}
