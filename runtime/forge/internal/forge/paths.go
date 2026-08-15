package forge

import (
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/lifecycle/layout"
)

// --- directory helpers ---

func exists(path string) bool { _, err := os.Stat(path); return err == nil }

func dirExists(path string) bool { info, err := os.Stat(path); return err == nil && info.IsDir() }

func userHome() string {
	for _, key := range []string{"HOME", "USERPROFILE"} {
		if home := strings.TrimSpace(os.Getenv(key)); home != "" {
			return home
		}
	}
	home, _ := os.UserHomeDir()
	return home
}

func expandHome(value string) string {
	if value == "~" {
		return userHome()
	}
	if strings.HasPrefix(value, "~/") {
		return filepath.Join(userHome(), value[2:])
	}
	return value
}

func readTextIfExists(path string) string {
	content, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(content)
}

func dirNames(path string) []string {
	entries, err := os.ReadDir(path)
	if err != nil {
		return []string{}
	}
	out := []string{}
	for _, entry := range entries {
		if entry.IsDir() && entry.Name() != "__pycache__" {
			out = append(out, entry.Name())
		}
	}
	sort.Strings(out)
	return out
}

// --- user config paths ---

func userConfigDir() string { return layout.NewPaths(userHome()).ConfigDir() }

func userSecretsPath() string { return filepath.Join(userConfigDir(), "secrets.json") }
func userConfigPath() string  { return filepath.Join(userConfigDir(), "config.json") }

func userCapabilitiesPath() string {
	return filepath.Join(userConfigDir(), "capabilities.json")
}

// --- layout paths (from paths.go) ---

func repoDir() (string, error) { return layout.NewPaths(userHome()).RepoDir() }

func commonRepoDirs(home string) []string { return layout.NewPaths(home).CommonRepoDirs(home) }

func currentForgePath() (string, error) { return layout.NewPaths(userHome()).CurrentForgePath() }

func forgeDataHome() string { return layout.NewPaths(userHome()).DataHome() }

func forgeDataDir() string { return layout.NewPaths(userHome()).DataDir() }

func forgeVersionsDir() string { return layout.NewPaths(userHome()).VersionsDir() }

func forgeCurrentPointerPath() string { return layout.NewPaths(userHome()).CurrentPointerPath() }

func stableForgeLauncherPath() string { return layout.NewPaths(userHome()).StableForgeLauncherPath() }

func stableForgeLauncherMarkerPath() string {
	return layout.NewPaths(userHome()).StableForgeLauncherMarkerPath()
}

func forgeBinaryArtifactName() string { return layout.NewPaths(userHome()).BinaryArtifactName() }

func stableForgeLauncherReady() bool { return layout.NewPaths(userHome()).StableForgeLauncherReady() }
