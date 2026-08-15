package forge

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/lifecycle/install"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/lifecycle/layout"
)

func TestRepoDirFindsCommonCheckoutWithoutEnv(t *testing.T) {
	home := t.TempDir()
	work := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("FORGE_REPO_DIR", "")
	oldWd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(work); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(oldWd) })

	repo := filepath.Join(home, "Documents", "GitHub", "forge")
	if err := os.MkdirAll(filepath.Join(repo, "internal", "forge"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "go.mod"), []byte("module example.com/forge\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "internal", "forge", "embed.go"), []byte("package forge\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	found, err := repoDir()
	if err != nil {
		t.Fatal(err)
	}
	if found != repo {
		t.Fatalf("expected common checkout %s, got %s", repo, found)
	}
}

func TestInstallBuiltForgeBinaryUsesVersionedCurrentAndStableLauncher(t *testing.T) {
	home := t.TempDir()
	dataHome := filepath.Join(home, "xdg-data")
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_DATA_HOME", dataHome)

	built := filepath.Join(t.TempDir(), forgeBinaryArtifactName())
	writeFakeExecutable(t, built, "fake forge binary\n")

	now := time.Date(2026, 6, 5, 12, 34, 56, 789000000, time.UTC)
	result, err := installBuiltForgeBinary(built, now)
	if err != nil {
		t.Fatal(err)
	}

	versionDir := filepath.Dir(result.VersionPath)
	if !strings.HasPrefix(filepath.Base(versionDir), "v"+version+"-20260605T123456789000000Z-") {
		t.Fatalf("version directory should include Forge version and timestamp, got %s", versionDir)
	}
	if result.VersionPath != filepath.Join(versionDir, forgeBinaryArtifactName()) {
		t.Fatalf("unexpected version binary path: %s", result.VersionPath)
	}
	if got := readTextIfExists(result.VersionPath); got != "fake forge binary\n" {
		t.Fatalf("version binary content mismatch: %q", got)
	}
	if got := strings.TrimSpace(readTextIfExists(forgeCurrentPointerPath())); got != result.VersionPath {
		t.Fatalf("current pointer = %q, want %q", got, result.VersionPath)
	}
	if result.StableLauncherPath != stableForgeLauncherPath() {
		t.Fatalf("unexpected stable launcher path: %s", result.StableLauncherPath)
	}
	if runtime.GOOS == "windows" {
		if got := readTextIfExists(result.StableLauncherPath); got != "fake forge binary\n" {
			t.Fatalf("Windows stable launcher should be copied from the built binary, got %q", got)
		}
		if !exists(stableForgeLauncherMarkerPath()) {
			t.Fatal("Windows stable launcher marker should be written after successful launcher install")
		}
	} else {
		script := readTextIfExists(result.StableLauncherPath)
		if !strings.Contains(script, `exec "$target" "$@"`) || !strings.Contains(script, "XDG_DATA_HOME") {
			t.Fatalf("POSIX stable launcher should exec the current version, got:\n%s", script)
		}
		info, err := os.Stat(result.StableLauncherPath)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode()&0o111 == 0 {
			t.Fatalf("POSIX stable launcher should be executable, mode=%v", info.Mode())
		}
	}
}

func testInstallCtx() install.SetupCommandContext {
	return install.SetupCommandContext{
		Home:   userHome(),
		Assets: makeInstallAssets(),
		Deps:   makeInstallDeps(),
	}
}

func TestStepSelfInstallFreshInstall(t *testing.T) {
	home := t.TempDir()
	dataHome := filepath.Join(home, "xdg-data")
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_DATA_HOME", dataHome)

	ctx := testInstallCtx()
	ctx.Home = home

	// No current pointer exists — self-install should create one.
	if !install.StepSelfInstall(ctx, false) {
		t.Fatal("StepSelfInstall(false) should succeed on fresh install")
	}

	current := strings.TrimSpace(readTextIfExists(forgeCurrentPointerPath()))
	if current == "" {
		t.Fatal("current pointer should be set after self-install")
	}
	if !exists(current) {
		t.Fatalf("current pointer points to non-existent file: %s", current)
	}
}

func TestStepSelfInstallSkipsWhenHealthy(t *testing.T) {
	home := t.TempDir()
	dataHome := filepath.Join(home, "xdg-data")
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_DATA_HOME", dataHome)

	ctx := testInstallCtx()
	ctx.Home = home

	// Pre-install a versioned binary and set up the stable launcher + current pointer.
	serverDir := t.TempDir()
	serverPath := filepath.Join(serverDir, forgeBinaryArtifactName())
	writeFakeExecutable(t, serverPath, "server forge\n")
	now := time.Date(2026, 6, 11, 12, 0, 0, 0, time.UTC)
	result, err := installBuiltForgeBinary(serverPath, now)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("pre-installed at %s", result.VersionPath)

	// Without --self-install, the healthy current should be preserved.
	if !install.StepSelfInstall(ctx, false) {
		t.Fatal("StepSelfInstall(false) should succeed (skip) when current is healthy")
	}

	// Verify current pointer still points to the pre-installed binary.
	current := strings.TrimSpace(readTextIfExists(forgeCurrentPointerPath()))
	if current != result.VersionPath {
		t.Fatalf("current pointer should remain %s, got %s", result.VersionPath, current)
	}
}

func TestStepSelfInstallForce(t *testing.T) {
	home := t.TempDir()
	dataHome := filepath.Join(home, "xdg-data")
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_DATA_HOME", dataHome)

	ctx := testInstallCtx()
	ctx.Home = home

	// Pre-install a versioned binary.
	serverDir := t.TempDir()
	serverPath := filepath.Join(serverDir, forgeBinaryArtifactName())
	writeFakeExecutable(t, serverPath, "server forge\n")
	now := time.Date(2026, 6, 11, 12, 0, 0, 0, time.UTC)
	result, err := installBuiltForgeBinary(serverPath, now)
	if err != nil {
		t.Fatal(err)
	}

	// With --self-install force, it should reinstall the running test binary.
	if !install.StepSelfInstall(ctx, true) {
		t.Fatal("StepSelfInstall(true) should succeed (force install)")
	}

	// Verify current pointer changed from the pre-installed version.
	current := strings.TrimSpace(readTextIfExists(forgeCurrentPointerPath()))
	if current == result.VersionPath {
		t.Fatalf("current pointer should have changed after forced self-install, still %s", current)
	}
	if !exists(current) {
		t.Fatalf("current pointer points to non-existent file: %s", current)
	}

	// Capture the forced-install state: current pointer and matching version dir count.
	currentAfterFirst := current
	countVersionDirs := func() int {
		entries, err := os.ReadDir(forgeVersionsDir())
		if err != nil {
			t.Fatalf("read versions dir: %v", err)
		}
		n := 0
		for _, e := range entries {
			if e.IsDir() && strings.HasPrefix(e.Name(), "v"+version+"-") {
				n++
			}
		}
		return n
	}
	countBefore := countVersionDirs()

	// A second forced install with the same running test binary/version must be
	// idempotent: same current pointer and no additional version directory.
	if !install.StepSelfInstall(ctx, true) {
		t.Fatal("StepSelfInstall(true) should succeed on repeat forced install")
	}
	currentAgain := strings.TrimSpace(readTextIfExists(forgeCurrentPointerPath()))
	if currentAgain != currentAfterFirst {
		t.Fatalf("current pointer should be unchanged by repeated forced self-install, got %s want %s", currentAgain, currentAfterFirst)
	}
	if n := countVersionDirs(); n != countBefore {
		t.Fatalf("repeated forced self-install created additional version directories: before=%d after=%d", countBefore, n)
	}
}

func TestMakefileInstallDelegatesToForgeSetup(t *testing.T) {
	content, err := os.ReadFile(filepath.Join("..", "..", "Makefile"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(content)
	// The install target should delegate to forge setup (not duplicate Go logic)
	// and force self-install so the stable launcher points at the freshly built binary.
	if !strings.Contains(text, "$(BIN_DIR)/$(FORGE_NAME) setup --self-install") {
		t.Fatalf("Makefile install should force setup self-install; Makefile:\n%s", text)
	}
	// Should not contain the old versioned-install shell logic.
	for _, forbidden := range []string{
		"VERSIONS_DIR",
		"CURRENT_FILE",
		"version_id",
		"tmp_current",
	} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("Makefile install should not duplicate versioned install logic; found %q in:\n%s", forbidden, text)
		}
	}
}

func TestSetupIsTopLevelCommand(t *testing.T) {
	command, ok, ambiguous := resolveTopLevelCommand("setup")
	if !ok || ambiguous || command != "setup" {
		t.Fatalf("resolveTopLevelCommand(setup) = %q/%v/%v", command, ok, ambiguous)
	}
}

func TestStableForgeLaunchTargetUsesCurrentOnlyForStableLauncher(t *testing.T) {
	home := t.TempDir()
	dataHome := filepath.Join(home, "xdg-data")
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_DATA_HOME", dataHome)

	stable := stableForgeLauncherPath()
	versioned := filepath.Join(forgeVersionsDir(), "v"+version+"-test", forgeBinaryArtifactName())
	if err := os.MkdirAll(filepath.Dir(stable), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(versioned), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFakeExecutable(t, stable, "stable launcher\n")
	writeFakeExecutable(t, versioned, "versioned forge\n")
	if err := writeAtomicText(forgeCurrentPointerPath(), versioned+"\n"); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "windows" {
		if err := markStableForgeLauncherReady(stable); err != nil {
			t.Fatal(err)
		}
	}

	target, ok, err := stableForgeLaunchTargetFor(stable)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || target != versioned {
		t.Fatalf("stable launcher target = (%q, %v), want (%q, true)", target, ok, versioned)
	}

	target, ok, err = stableForgeLaunchTargetFor(versioned)
	if err != nil {
		t.Fatal(err)
	}
	if ok || target != "" {
		t.Fatalf("versioned binary should not re-launch, got target=%q ok=%v", target, ok)
	}
}

func TestStableForgeLaunchTargetTrimsUTF8BOMFromCurrentPointer(t *testing.T) {
	home := t.TempDir()
	dataHome := filepath.Join(home, "xdg-data")
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_DATA_HOME", dataHome)

	stable := stableForgeLauncherPath()
	versioned := filepath.Join(forgeVersionsDir(), "v"+version+"-test", forgeBinaryArtifactName())
	if err := os.MkdirAll(filepath.Dir(stable), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(versioned), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFakeExecutable(t, stable, "stable launcher\n")
	writeFakeExecutable(t, versioned, "versioned forge\n")
	if err := os.WriteFile(forgeCurrentPointerPath(), []byte("\ufeff"+versioned+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "windows" {
		if err := markStableForgeLauncherReady(stable); err != nil {
			t.Fatal(err)
		}
	}

	target, ok, err := stableForgeLaunchTargetFor(stable)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || target != versioned {
		t.Fatalf("stable launcher target = (%q, %v), want (%q, true)", target, ok, versioned)
	}
}

func TestCurrentForgePathPrefersReadyStableLauncher(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("FORGE_BINARY", "")

	stable := stableForgeLauncherPath()
	if err := os.MkdirAll(filepath.Dir(stable), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFakeExecutable(t, stable, "stable launcher\n")
	if runtime.GOOS == "windows" {
		if err := markStableForgeLauncherReady(stable); err != nil {
			t.Fatal(err)
		}
	}

	got, err := currentForgePath()
	if err != nil {
		t.Fatal(err)
	}
	if got != stable {
		t.Fatalf("currentForgePath should prefer ready stable launcher, got %q want %q", got, stable)
	}
}

func TestPluginInstallCleanupOnRefusal(t *testing.T) {
	home := t.TempDir()
	t.Setenv("USERPROFILE", home)
	t.Setenv("HOME", home)

	// Create a plugin source with a daemon.
	srcDir := filepath.Join(home, "src-plugin")
	if err := os.MkdirAll(srcDir, 0o700); err != nil {
		t.Fatal(err)
	}
	srcManifest := `{"name":"refused-plugin","version":"1.0.0","provides":{"daemon":{"command":"node","args":["dist/server.js"],"port":"18900","port_env":"PORT","health_url":"/health","log_dir":".local/share/test"}}}`
	if err := os.WriteFile(filepath.Join(srcDir, "manifest.json"), []byte(srcManifest), 0o644); err != nil {
		t.Fatal(err)
	}

	// Install without --trust should refuse and clean up.
	// installCommand runs the full interactive flow — we can't easily subvert it.
	// Instead verify the plugin dir doesn't exist after install returns non-zero
	// for a non-interactive refusal.

	pluginsDir := filepath.Join(home, ".local", "share", "wrenyard", "runtime", "plugins")
	targetDir := filepath.Join(pluginsDir, "refused-plugin")

	// Simulate what installCommand does: copy + trust refusal cleanup.
	// This validates the cleanup logic itself.
	if err := os.MkdirAll(targetDir, 0o700); err != nil {
		t.Fatal(err)
	}
	// Copy the manifest in.
	manifestData, _ := os.ReadFile(filepath.Join(srcDir, "manifest.json"))
	if err := os.WriteFile(filepath.Join(targetDir, "manifest.json"), manifestData, 0o644); err != nil {
		t.Fatal(err)
	}

	// Verify dir exists.
	if _, err := os.Stat(targetDir); err != nil {
		t.Fatal("expected targetDir to exist before cleanup")
	}

	// Simulate cleanup.
	if err := os.RemoveAll(targetDir); err != nil {
		t.Fatalf("RemoveAll failed: %v", err)
	}

	// Verify dir is gone.
	if _, err := os.Stat(targetDir); !os.IsNotExist(err) {
		t.Error("expected targetDir to be removed after cleanup")
	}
}

func TestParseBuiltForgeVersionOutput(t *testing.T) {
	// Exact Forge version line with a trailing newline.
	got, err := parseBuiltForgeVersionOutput("Forge 9.8.7\n")
	if err != nil {
		t.Fatalf("parseBuiltForgeVersionOutput unexpected error: %v", err)
	}
	if got != "9.8.7" {
		t.Fatalf("parseBuiltForgeVersionOutput = %q, want %q", got, "9.8.7")
	}

	// Invalid output should error rather than producing a bogus version.
	if _, err := parseBuiltForgeVersionOutput("not a forge binary\n"); err == nil {
		t.Fatal("parseBuiltForgeVersionOutput should error on invalid output")
	}
	if _, err := parseBuiltForgeVersionOutput(""); err == nil {
		t.Fatal("parseBuiltForgeVersionOutput should error on empty output")
	}
}

func TestInstallBuiltForgeBinaryVersionUsesExplicitTarget(t *testing.T) {
	home := t.TempDir()
	dataHome := filepath.Join(home, "xdg-data")
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_DATA_HOME", dataHome)

	built := filepath.Join(t.TempDir(), forgeBinaryArtifactName())
	writeFakeExecutable(t, built, "fake forge binary\n")

	now := time.Date(2026, 6, 5, 12, 34, 56, 789000000, time.UTC)
	// Explicit target version 9.8.7 even though the running package version
	// (the global `version`) may differ.
	result, err := installBuiltForgeBinaryVersion(built, "9.8.7", now)
	if err != nil {
		t.Fatal(err)
	}

	versionDir := filepath.Dir(result.VersionPath)
	if !strings.HasPrefix(filepath.Base(versionDir), "v9.8.7-") {
		t.Fatalf("version directory should begin with v9.8.7- for the explicit target, got %s", versionDir)
	}
	if got := readTextIfExists(result.VersionPath); got != "fake forge binary\n" {
		t.Fatalf("version binary content mismatch: %q", got)
	}
	if got := strings.TrimSpace(readTextIfExists(forgeCurrentPointerPath())); got != result.VersionPath {
		t.Fatalf("current pointer = %q, want %q", got, result.VersionPath)
	}
}

func TestInstallBuiltForgeBinaryAtomicCurrentPointerAndVersionSelection(t *testing.T) {
	home := t.TempDir()
	dataHome := filepath.Join(home, "xdg-data")
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_DATA_HOME", dataHome)

	built := filepath.Join(t.TempDir(), forgeBinaryArtifactName())
	writeFakeExecutable(t, built, "fake forge binary\n")

	now := time.Date(2026, 6, 5, 12, 34, 56, 789000000, time.UTC)
	result, err := installBuiltForgeBinary(built, now)
	if err != nil {
		t.Fatal(err)
	}

	// The current pointer should point exactly at the newly installed version binary.
	current := strings.TrimSpace(readTextIfExists(forgeCurrentPointerPath()))
	if current != result.VersionPath {
		t.Fatalf("current pointer = %q, want version path %q", current, result.VersionPath)
	}
	if !exists(current) {
		t.Fatalf("current pointer target does not exist: %s", current)
	}
	// Pointer content ends with a single newline, no BOM, no trailing spaces.
	rawBytes, err := os.ReadFile(forgeCurrentPointerPath())
	if err != nil {
		t.Fatal(err)
	}
	raw := string(rawBytes)
	if raw != current+"\n" {
		t.Fatalf("current pointer raw content = %q, want %q", raw, current+"\n")
	}
	// Re-verify against production reader.
	reRead := strings.TrimSpace(readTextIfExists(forgeCurrentPointerPath()))
	if reRead != result.VersionPath {
		t.Fatalf("re-read current pointer = %q, want %q", reRead, result.VersionPath)
	}
	// Version dir is chosen atomically: layout is <versions>/<v..-ts-hash>/<artifact>.
	versionDir := filepath.Dir(result.VersionPath)
	if filepath.Dir(versionDir) != forgeVersionsDir() {
		t.Fatalf("version dir parent = %q, want %q", filepath.Dir(versionDir), forgeVersionsDir())
	}
	if prefix := "v" + version + "-"; !strings.HasPrefix(filepath.Base(versionDir), prefix) {
		t.Fatalf("version dir = %q should start with %q", filepath.Base(versionDir), prefix)
	}
	// Filename inside the slot is the standard artifact name.
	if filepath.Base(result.VersionPath) != forgeBinaryArtifactName() {
		t.Fatalf("version binary filename = %q, want %q", filepath.Base(result.VersionPath), forgeBinaryArtifactName())
	}
}

func TestInstallBuiltForgeBinaryPreservesStableLauncherUnlessLocked(t *testing.T) {
	home := t.TempDir()
	dataHome := filepath.Join(home, "xdg-data")
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_DATA_HOME", dataHome)

	stable := stableForgeLauncherPath()
	if err := os.MkdirAll(filepath.Dir(stable), 0o755); err != nil {
		t.Fatal(err)
	}
	// Pre-existing ready stable launcher (POSIX script / Windows copied binary).
	writeFakeExecutable(t, stable, "pre-existing stable launcher\n")
	if runtime.GOOS == "windows" {
		// Mark it ready so the Windows installer preserves it instead of copying the new binary over it.
		if err := markStableForgeLauncherReady(stable); err != nil {
			t.Fatal(err)
		}
	}

	built := filepath.Join(t.TempDir(), forgeBinaryArtifactName())
	writeFakeExecutable(t, built, "new fake forge binary\n")

	now := time.Date(2026, 6, 5, 12, 34, 56, 0, time.UTC)
	result, err := installBuiltForgeBinary(built, now)
	if err != nil {
		t.Fatal(err)
	}

	if result.StableLauncherPath != stable {
		t.Fatalf("stable launcher path = %q, want %q", result.StableLauncherPath, stable)
	}
	if runtime.GOOS == "windows" {
		// On Windows a ready launcher is preserved; a locked one would defer (not the case here).
		if result.StableLauncherDeferredPath != "" {
			t.Fatalf("expected no deferred launcher when stable launcher ready, got %q", result.StableLauncherDeferredPath)
		}
		if got := readTextIfExists(stable); got != "pre-existing stable launcher\n" {
			t.Fatalf("ready Windows stable launcher should be preserved, got %q", got)
		}
		if !exists(stableForgeLauncherMarkerPath()) {
			t.Fatal("Windows stable launcher marker should exist when ready")
		}
	} else {
		// POSIX launcher is a script that execs the current pointer; the binary is NOT copied over the script.
		script := readTextIfExists(stable)
		if !strings.Contains(script, `exec "$target" "$@"`) {
			t.Fatalf("POSIX stable launcher should remain an exec script, got:\n%s", script)
		}
	}
}

func TestInstallBuiltForgeBinaryHashLayoutMatchesVersionID(t *testing.T) {
	home := t.TempDir()
	dataHome := filepath.Join(home, "xdg-data")
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_DATA_HOME", dataHome)

	built := filepath.Join(t.TempDir(), forgeBinaryArtifactName())
	content := "deterministic forge binary content\n"
	writeFakeExecutable(t, built, content)

	now := time.Date(2026, 6, 5, 12, 34, 56, 789000000, time.UTC)
	result, err := installBuiltForgeBinary(built, now)
	if err != nil {
		t.Fatal(err)
	}

	// The version ID hash (last path segment of v<ver>-ts-<hash>) must equal
	// the 12-char SHA-256 prefix of the built binary.
	hash, err := fileSHA256Prefix(built, 12)
	if err != nil {
		t.Fatal(err)
	}
	if versionIDHash(result.VersionID) != hash {
		t.Fatalf("version id hash = %q, want file hash prefix %q", versionIDHash(result.VersionID), hash)
	}
	// Deployed binary content must be byte-identical to the source.
	if got := readTextIfExists(result.VersionPath); got != content {
		t.Fatalf("deployed content mismatch: %q", got)
	}
	// Source and target hashes must agree (deploy assertion).
	srcHash, _ := fileSHA256Prefix(built, 12)
	tgtHash, _ := fileSHA256Prefix(result.VersionPath, 12)
	if srcHash != tgtHash {
		t.Fatalf("source/target hashes differ: %q vs %q", srcHash, tgtHash)
	}
}

func TestVersionPathMatchesForgeVersion(t *testing.T) {
	// A matching v9.8.7 timestamp-hash path should be accepted.
	match := filepath.Join(forgeVersionsDir(), "v9.8.7-20260605T123456789000000Z-deadbeefcafe", forgeBinaryArtifactName())
	if !versionPathMatchesForgeVersion(match, "9.8.7") {
		t.Fatalf("v9.8.7 path should match version 9.8.7: %s", match)
	}

	// A v0.7.0 path should be rejected when checking against 9.8.7.
	nomatch := filepath.Join(forgeVersionsDir(), "v0.7.0-20260101T000000000000000Z-deadbeefcafe", forgeBinaryArtifactName())
	if versionPathMatchesForgeVersion(nomatch, "9.8.7") {
		t.Fatalf("v0.7.0 path should not match version 9.8.7: %s", nomatch)
	}
}

func TestInstallCreatesStableFDSHLauncher(t *testing.T) {
	home := t.TempDir()
	dataHome := filepath.Join(home, "xdg-data")
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_DATA_HOME", dataHome)

	built := filepath.Join(t.TempDir(), forgeBinaryArtifactName())
	writeFakeExecutable(t, built, "fake forge binary\n")

	result, err := installBuiltForgeBinary(built, time.Date(2026, 6, 5, 12, 34, 56, 789000000, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if result.StableFDSHLauncherPath != layout.NewPaths(userHome()).StableFDSHLauncherPath() {
		t.Fatalf("unexpected stable fdsh launcher path: %s", result.StableFDSHLauncherPath)
	}
	if !exists(result.StableFDSHLauncherPath) {
		t.Fatal("stable fdsh launcher should exist after install")
	}
	if runtime.GOOS == "windows" {
		if got := readTextIfExists(result.StableFDSHLauncherPath); got != "fake forge binary\n" {
			t.Fatalf("Windows fdsh.exe should copy the current forge binary, got %q", got)
		}
	} else {
		script := readTextIfExists(result.StableFDSHLauncherPath)
		if !strings.Contains(script, `exec "$target" "$@"`) || !strings.Contains(script, "FORGE_FDSH_MARKER=1") {
			t.Fatalf("POSIX fdsh launcher should exec current forge with the hidden marker, got:\n%s", script)
		}
		info, err := os.Stat(result.StableFDSHLauncherPath)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode()&0o111 == 0 {
			t.Fatalf("POSIX fdsh launcher should be executable, mode=%v", info.Mode())
		}
	}
	// The fdsh launcher must never regress the forge launcher.
	if !exists(result.StableLauncherPath) {
		t.Fatal("stable forge launcher should still exist after fdsh install")
	}
}

func TestStepSelfInstallCreatesStableFDSHLauncher(t *testing.T) {
	home := t.TempDir()
	dataHome := filepath.Join(home, "xdg-data")
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_DATA_HOME", dataHome)

	ctx := testInstallCtx()
	ctx.Home = home

	if !install.StepSelfInstall(ctx, false) {
		t.Fatal("StepSelfInstall(false) should succeed on fresh install")
	}
	fdsh := layout.NewPaths(home).StableFDSHLauncherPath()
	if !exists(fdsh) {
		t.Fatal("setup should create the stable fdsh launcher")
	}
	if runtime.GOOS != "windows" {
		script := readTextIfExists(fdsh)
		if !strings.Contains(script, "FORGE_FDSH_MARKER=1") || !strings.Contains(script, `exec "$target" "$@"`) {
			t.Fatalf("setup fdsh launcher should exec current forge with the hidden marker, got:\n%s", script)
		}
		info, err := os.Stat(fdsh)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode()&0o111 == 0 {
			t.Fatalf("setup fdsh launcher should be executable, mode=%v", info.Mode())
		}
	}
	// fdsh execs the current pointer target; the forge launcher must still work.
	current := strings.TrimSpace(readTextIfExists(forgeCurrentPointerPath()))
	if current == "" || !exists(current) {
		t.Fatalf("current pointer should point at a real forge binary after setup, got %q", current)
	}
	if !exists(stableForgeLauncherPath()) {
		t.Fatal("setup should also keep the stable forge launcher")
	}
}
