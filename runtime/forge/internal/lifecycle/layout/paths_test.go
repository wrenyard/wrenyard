package layout

import (
	"os"
	"path/filepath"
	"testing"
)

// writeForgeModuleMarkers creates the minimal Forge module markers under root.
func writeForgeModuleMarkers(t *testing.T, root string) {
	t.Helper()
	for _, rel := range []string{"go.mod", filepath.Join("internal", "forge", "embed.go")} {
		path := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
		}
		if err := os.WriteFile(path, []byte("// marker\n"), 0o644); err != nil {
			t.Fatalf("write %s: %v", path, err)
		}
	}
}

// chdirForTest changes the working directory for the duration of the test.
func chdirForTest(t *testing.T, dir string) {
	t.Helper()
	prev, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatalf("chdir %s: %v", dir, err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(prev); err != nil {
			t.Errorf("restore cwd: %v", err)
		}
	})
}

// resolvedPath returns the canonical path so expected values match what
// os.Getwd reports after chdir (e.g. /var -> /private/var on macOS).
func resolvedPath(t *testing.T, path string) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatalf("resolve %s: %v", path, err)
	}
	return resolved
}

func hasDir(dirs []string, want string) bool {
	for _, d := range dirs {
		if d == want {
			return true
		}
	}
	return false
}

// TestRepoDirFromForemanService verifies monorepo discovery of
// <suite>/runtime/forge when cwd is <suite>/services/foreman and env is unset.
func TestRepoDirFromForemanService(t *testing.T) {
	suite := filepath.Join(t.TempDir(), "suite")
	writeForgeModuleMarkers(t, filepath.Join(suite, "runtime", "forge"))
	suite = resolvedPath(t, suite)
	foreman := filepath.Join(suite, "services", "foreman")
	if err := os.MkdirAll(foreman, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", foreman, err)
	}
	t.Setenv("FORGE_REPO_DIR", "")
	chdirForTest(t, foreman)

	p := NewPaths(t.TempDir())
	got, err := p.RepoDir()
	if err != nil {
		t.Fatalf("RepoDir: %v", err)
	}
	want := filepath.Join(suite, "runtime", "forge")
	if got != want {
		t.Errorf("RepoDir = %q, want %q", got, want)
	}
}

// TestRepoDirSuiteRootViaEnv verifies a WRENYARD-like suite root passed via
// FORGE_REPO_DIR resolves to its runtime/forge directory.
func TestRepoDirSuiteRootViaEnv(t *testing.T) {
	suite := filepath.Join(t.TempDir(), "suite")
	writeForgeModuleMarkers(t, filepath.Join(suite, "runtime", "forge"))
	t.Setenv("FORGE_REPO_DIR", suite)

	p := NewPaths(t.TempDir())
	got, err := p.RepoDir()
	if err != nil {
		t.Fatalf("RepoDir: %v", err)
	}
	want := filepath.Join(suite, "runtime", "forge")
	if got != want {
		t.Errorf("RepoDir = %q, want %q", got, want)
	}
}

// TestRepoDirExplicitModulePathPreserved verifies an explicit FORGE_REPO_DIR
// that is an arbitrary module path is returned as its absolute value.
func TestRepoDirExplicitModulePathPreserved(t *testing.T) {
	module := filepath.Join(t.TempDir(), "plain")
	if err := os.MkdirAll(module, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", module, err)
	}
	t.Setenv("FORGE_REPO_DIR", module)

	p := NewPaths(t.TempDir())
	got, err := p.RepoDir()
	if err != nil {
		t.Fatalf("RepoDir: %v", err)
	}
	if got != module {
		t.Errorf("RepoDir = %q, want %q", got, module)
	}
}

// TestRepoDirDirectModuleAncestor verifies ancestor discovery from a deep
// subdirectory of a direct Forge module root.
func TestRepoDirDirectModuleAncestor(t *testing.T) {
	module := filepath.Join(t.TempDir(), "forge")
	writeForgeModuleMarkers(t, module)
	module = resolvedPath(t, module)
	deep := filepath.Join(module, "sub", "deep")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", deep, err)
	}
	t.Setenv("FORGE_REPO_DIR", "")
	chdirForTest(t, deep)

	p := NewPaths(t.TempDir())
	got, err := p.RepoDir()
	if err != nil {
		t.Fatalf("RepoDir: %v", err)
	}
	if got != module {
		t.Errorf("RepoDir = %q, want %q", got, module)
	}
}

// TestCommonRepoDirsWrenyardAndLegacy verifies CommonRepoDirs keeps the
// legacy forge/ai-config candidates and adds the Wrenyard runtime/forge ones.
func TestCommonRepoDirsWrenyardAndLegacy(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	p := NewPaths(home)
	dirs := p.CommonRepoDirs(home)
	for _, want := range []string{
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
	} {
		if !hasDir(dirs, want) {
			t.Errorf("CommonRepoDirs missing %q; got %v", want, dirs)
		}
	}
}

// TestWrenyardRuntimeLayout verifies the Wrenyard 1.0.0-dev.0 runtime
// directory contract: runtime config under ~/.config/wrenyard/runtime,
// data/auth/session/versions under ~/.local/share/wrenyard/runtime, and
// state under ~/.local/state/wrenyard/runtime, with XDG overrides preserved.
func TestWrenyardRuntimeLayout(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("XDG_DATA_HOME", "")
	t.Setenv("XDG_STATE_HOME", "")
	p := NewPaths(home)

	if got := p.ConfigDir(); got != filepath.Join(home, ".config", "wrenyard", "runtime") {
		t.Errorf("ConfigDir = %q, want %q", got, filepath.Join(home, ".config", "wrenyard", "runtime"))
	}
	if got := p.DataDir(); got != filepath.Join(home, ".local", "share", "wrenyard", "runtime") {
		t.Errorf("DataDir = %q, want %q", got, filepath.Join(home, ".local", "share", "wrenyard", "runtime"))
	}
	if got := p.VersionsDir(); got != filepath.Join(home, ".local", "share", "wrenyard", "runtime", "versions") {
		t.Errorf("VersionsDir = %q, want %q", got, filepath.Join(home, ".local", "share", "wrenyard", "runtime", "versions"))
	}
	if got := p.StateDir(); got != filepath.Join(home, ".local", "state", "wrenyard", "runtime") {
		t.Errorf("StateDir = %q, want %q", got, filepath.Join(home, ".local", "state", "wrenyard", "runtime"))
	}
	if got := p.StableForgeLauncherMarkerPath(); got != filepath.Join(home, ".local", "state", "wrenyard", "runtime", "stable-launcher-ready") {
		t.Errorf("StableForgeLauncherMarkerPath = %q, want %q", got, filepath.Join(home, ".local", "state", "wrenyard", "runtime", "stable-launcher-ready"))
	}

	// XDG overrides remain authoritative.
	config := filepath.Join(home, "xdg-config")
	data := filepath.Join(home, "xdg-data")
	state := filepath.Join(home, "xdg-state")
	t.Setenv("XDG_CONFIG_HOME", config)
	t.Setenv("XDG_DATA_HOME", data)
	t.Setenv("XDG_STATE_HOME", state)
	if got := p.ConfigDir(); got != filepath.Join(config, "wrenyard", "runtime") {
		t.Errorf("ConfigDir with override = %q, want %q", got, filepath.Join(config, "wrenyard", "runtime"))
	}
	if got := p.DataDir(); got != filepath.Join(data, "wrenyard", "runtime") {
		t.Errorf("DataDir with override = %q, want %q", got, filepath.Join(data, "wrenyard", "runtime"))
	}
	if got := p.StateDir(); got != filepath.Join(state, "wrenyard", "runtime") {
		t.Errorf("StateDir with override = %q, want %q", got, filepath.Join(state, "wrenyard", "runtime"))
	}
}
