package layout

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Paths is an explicit value object for Forge repository/binary/data path
// calculations. It is constructed with the user home directory so the layout
// package has no dependency on the root forge package.
type Paths struct {
	Home string
}

// NewPaths builds a Paths value object for the given home directory.
func NewPaths(home string) Paths {
	return Paths{Home: home}
}

func exists(path string) bool { _, err := os.Stat(path); return err == nil }

// isForgeModuleRoot reports whether dir is a direct Forge module root,
// identified by its go.mod and internal/forge/embed.go markers.
func isForgeModuleRoot(dir string) bool {
	return exists(filepath.Join(dir, "go.mod")) &&
		exists(filepath.Join(dir, "internal", "forge", "embed.go"))
}

// resolveForgeRoot returns the actual Forge module directory for dir,
// recognizing either a direct Forge module root or a suite root that
// contains runtime/forge carrying the Forge module markers.
func resolveForgeRoot(dir string) (string, bool) {
	if isForgeModuleRoot(dir) {
		return dir, true
	}
	if child := filepath.Join(dir, "runtime", "forge"); isForgeModuleRoot(child) {
		return child, true
	}
	return "", false
}

// RepoDir locates the Forge repository root, honoring FORGE_REPO_DIR with
// fallback candidate search. Exact errors are preserved. An explicit
// FORGE_REPO_DIR is normalized to an absolute path; if it names a suite
// root, the actual runtime/forge directory is returned.
func (p Paths) RepoDir() (string, error) {
	if configured := os.Getenv("FORGE_REPO_DIR"); configured != "" {
		abs, _ := filepath.Abs(configured)
		if root, ok := resolveForgeRoot(abs); ok {
			return root, nil
		}
		return abs, nil
	}
	candidates := []string{}
	if exe, err := os.Executable(); err == nil {
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			candidates = append(candidates, filepath.Dir(resolved))
		}
		candidates = append(candidates, filepath.Dir(exe))
	}
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates, cwd)
	}
	if p.Home != "" {
		candidates = append(candidates, p.CommonRepoDirs(p.Home)...)
	}
	seen := map[string]bool{}
	for _, start := range candidates {
		abs, _ := filepath.Abs(start)
		for {
			if !seen[abs] {
				seen[abs] = true
				if root, ok := resolveForgeRoot(abs); ok {
					return root, nil
				}
			}
			parent := filepath.Dir(abs)
			if parent == abs {
				break
			}
			abs = parent
		}
	}
	return "", errors.New("cannot locate Forge repository; set FORGE_REPO_DIR")
}

// CommonRepoDirs returns the checkout candidates for a given home.
// It keeps the legacy "forge" and "ai-config" checkouts and adds the
// Wrenyard monorepo runtime/forge locations.
func (p Paths) CommonRepoDirs(home string) []string {
	return []string{
		filepath.Join(home, "Documents", "GitHub", "forge"),
		filepath.Join(home, "GitHub", "forge"),
		filepath.Join(home, "github", "forge"),
		filepath.Join(home, "Projects", "forge"),
		filepath.Join(home, "Developer", "forge"),
		filepath.Join(home, "Documents", "GitHub", "ai-config"),
		filepath.Join(home, "GitHub", "ai-config"),
		filepath.Join(home, "github", "ai-config"),
		filepath.Join(home, "Projects", "ai-config"),
		filepath.Join(home, "Developer", "ai-config"),
		filepath.Join(home, "Documents", "GitHub", "wrenyard", "runtime", "forge"),
		filepath.Join(home, "GitHub", "wrenyard", "runtime", "forge"),
	}
}

// CurrentForgePath returns the path of the forge binary to invoke.
func (p Paths) CurrentForgePath() (string, error) {
	if configured := os.Getenv("FORGE_BINARY"); configured != "" {
		return filepath.Abs(configured)
	}
	if p.StableForgeLauncherReady() {
		return filepath.Abs(p.StableForgeLauncherPath())
	}
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return filepath.Abs(exe)
}

// ConfigDir returns the Wrenyard runtime config directory, honoring
// XDG_CONFIG_HOME precedence.
func (p Paths) ConfigDir() string {
	if configured := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME")); configured != "" {
		if abs, err := filepath.Abs(configured); err == nil {
			return filepath.Join(abs, "wrenyard", "runtime")
		}
		return filepath.Join(configured, "wrenyard", "runtime")
	}
	return filepath.Join(p.Home, ".config", "wrenyard", "runtime")
}

// StateDir returns the Wrenyard runtime state directory, honoring
// XDG_STATE_HOME precedence.
func (p Paths) StateDir() string {
	if configured := strings.TrimSpace(os.Getenv("XDG_STATE_HOME")); configured != "" {
		if abs, err := filepath.Abs(configured); err == nil {
			return filepath.Join(abs, "wrenyard", "runtime")
		}
		return filepath.Join(configured, "wrenyard", "runtime")
	}
	return filepath.Join(p.Home, ".local", "state", "wrenyard", "runtime")
}

// DataHome returns the XDG data home, honoring XDG_DATA_HOME precedence.
func (p Paths) DataHome() string {
	if configured := strings.TrimSpace(os.Getenv("XDG_DATA_HOME")); configured != "" {
		if abs, err := filepath.Abs(configured); err == nil {
			return abs
		}
		return configured
	}
	return filepath.Join(p.Home, ".local", "share")
}

// DataDir returns the Wrenyard runtime data directory, hosting data,
// auth, session and versions.
func (p Paths) DataDir() string {
	return filepath.Join(p.DataHome(), "wrenyard", "runtime")
}

// VersionsDir returns the forge versions directory.
func (p Paths) VersionsDir() string {
	return filepath.Join(p.DataDir(), "versions")
}

// CurrentPointerPath returns the path of the "current" version pointer.
func (p Paths) CurrentPointerPath() string {
	return filepath.Join(p.DataDir(), "current")
}

// StableForgeLauncherPath returns the path of the stable launcher symlink.
func (p Paths) StableForgeLauncherPath() string {
	return filepath.Join(p.Home, ".local", "bin", p.BinaryArtifactName())
}

// StableForgeLauncherMarkerPath returns the readiness marker path.
func (p Paths) StableForgeLauncherMarkerPath() string {
	return filepath.Join(p.StateDir(), "stable-launcher-ready")
}

// BinaryArtifactName returns the platform binary artifact name.
func (p Paths) BinaryArtifactName() string {
	if runtime.GOOS == "windows" {
		return "forge.exe"
	}
	return "forge"
}

// FDSHBinaryArtifactName returns the platform fdsh binary artifact name.
func (p Paths) FDSHBinaryArtifactName() string {
	if runtime.GOOS == "windows" {
		return "fdsh.exe"
	}
	return "fdsh"
}

// StableFDSHLauncherPath returns the path of the stable fdsh launcher.
func (p Paths) StableFDSHLauncherPath() string {
	return filepath.Join(p.Home, ".local", "bin", p.FDSHBinaryArtifactName())
}

// StableFDSHLauncherReady reports whether the stable fdsh launcher exists.
func (p Paths) StableFDSHLauncherReady() bool {
	return exists(p.StableFDSHLauncherPath())
}

// StableForgeLauncherReady reports whether the stable launcher is installed and
// (on Windows) marked ready.
func (p Paths) StableForgeLauncherReady() bool {
	stable := p.StableForgeLauncherPath()
	if !exists(stable) {
		return false
	}
	if runtime.GOOS != "windows" {
		return true
	}
	return exists(p.StableForgeLauncherMarkerPath())
}
