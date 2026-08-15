// Package grok implements the Forge shell-Grok multi-provider wrapper.
//
// It projects Forge-managed providers that expose an OpenAI-compatible raw
// protocol into Grok Build custom models, materializes a dedicated
// GROK_HOME config, and launches the official grok binary with only
// deterministic FORGE_GROK_<PROVIDER>_API_KEY values injected into the child
// environment. No API key is ever written to disk or printed.
package grok

import (
	"os"
	"path/filepath"
	"strings"
)

// Paths holds the resolved filesystem locations for the shell-Grok wrapper.
// All paths are derived from XDG environment variables with the same
// precedence Forge uses elsewhere.
type Paths struct {
	// GrokHome is the isolated GROK_HOME (${XDG_DATA_HOME:-~/.local/share}/forge/grok/shell-grok).
	GrokHome string
	// ConfigPath is the materialized Grok config (GROK_HOME/config.toml).
	ConfigPath string
	// OverlayPath is the optional human-maintained overlay (${XDG_CONFIG_HOME:-~/.config}/forge/grok/overlay.toml).
	OverlayPath string
}

// ResolvePaths computes the shell-Grok paths from the process environment.
// It honors XDG_DATA_HOME / XDG_CONFIG_HOME precedence and is safe to call in
// tests that t.Setenv those variables.
func ResolvePaths() Paths {
	dataHome := xdgDataHome(userHome())
	configHome := xdgConfigHome(userHome())
	grokHome := filepath.Join(dataHome, "forge", "grok", "shell-grok")
	return Paths{
		GrokHome:    grokHome,
		ConfigPath:  filepath.Join(grokHome, "config.toml"),
		OverlayPath: filepath.Join(configHome, "forge", "grok", "overlay.toml"),
	}
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

func xdgDataHome(home string) string {
	if dir := strings.TrimSpace(os.Getenv("XDG_DATA_HOME")); dir != "" {
		return dir
	}
	return filepath.Join(home, ".local", "share")
}

func xdgConfigHome(home string) string {
	if dir := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME")); dir != "" {
		return dir
	}
	return filepath.Join(home, ".config")
}
