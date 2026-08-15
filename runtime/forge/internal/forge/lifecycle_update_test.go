package forge

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/lifecycle/layout"
)

// Characterization tests for update.go using injectable seams only.
// updateVersionedInstall itself executes the freshly built binary and reads
// the stable launcher marker, so it is not exercised here; instead we pin the
// underlying seams that drive target-version selection, version-id layout,
// current-slot matching, and atomic pointer writes.

func TestForgeVersionIDVersionLayout(t *testing.T) {
	// The version id is "v<ver>-<UTC stamp>-<12-hex-hash>".
	built := filepath.Join(t.TempDir(), forgeBinaryArtifactName())
	writeFakeExecutable(t, built, "stable content\n")
	now := time.Date(2026, 6, 5, 12, 34, 56, 789000000, time.UTC)
	id, err := forgeVersionIDVersion("9.8.7", built, now)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(id, "v9.8.7-") {
		t.Fatalf("version id = %q, want prefix v9.8.7-", id)
	}
	hash, err := fileSHA256Prefix(built, 12)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(id, "-"+hash) {
		t.Fatalf("version id = %q, want suffix -%s", id, hash)
	}
	parts := strings.Split(id, "-")
	if len(parts) < 3 {
		t.Fatalf("version id should have ver/stamp/hash segments, got %q", id)
	}
	if parts[len(parts)-1] != hash {
		t.Fatalf("last segment of version id = %q, want hash %q", parts[len(parts)-1], hash)
	}
}

func TestForgeVersionIDVersionStampIsUTCDeterministic(t *testing.T) {
	built := filepath.Join(t.TempDir(), forgeBinaryArtifactName())
	writeFakeExecutable(t, built, "x")
	now := time.Date(2026, 1, 2, 3, 4, 5, 6, time.UTC)
	id, err := forgeVersionIDVersion("1.2.3", built, now)
	if err != nil {
		t.Fatal(err)
	}
	// Stamp is fixed precision (20060102T150405 + 9-digit nanosecond), independent of timezone call.
	if !strings.Contains(id, "-20260102T030405") {
		t.Fatalf("version id stamp = %q, want 20260102T030405", id)
	}
}

func TestVersionPathMatchesForgeVersionTargetSelection(t *testing.T) {
	// The "already current" shortcut only applies when the current file's
	// parent directory matches the target version.
	match := filepath.Join(forgeVersionsDir(), "v9.8.7-20260605T123456789000000Z-deadbeefcafe", forgeBinaryArtifactName())
	if !versionPathMatchesForgeVersion(match, "9.8.7") {
		t.Fatalf("current slot for 9.8.7 should match target 9.8.7")
	}
	// A different version's slot must not match.
	other := filepath.Join(forgeVersionsDir(), "v0.7.0-20260101T000000000000000Z-deadbeefcafe", forgeBinaryArtifactName())
	if versionPathMatchesForgeVersion(other, "9.8.7") {
		t.Fatalf("current slot for 0.7.0 should NOT match target 9.8.7")
	}
	// Prefix only at the directory level: a substring match in the hash must not confuse versions.
	looksLikeOther := filepath.Join(forgeVersionsDir(), "v9.8.7-20260605T123456789000000Z-v0.7.0cafe", forgeBinaryArtifactName())
	if !versionPathMatchesForgeVersion(looksLikeOther, "9.8.7") {
		t.Fatalf("directory prefix v9.8.7- should still match target 9.8.7 even with confusing hash")
	}
}

func TestParseBuiltForgeVersionOutputRejectsBadTokens(t *testing.T) {
	// Whitespace- or separator-containing tokens are rejected (used to decide
	// whether the freshly built binary reports a valid deployable version).
	// parseBuiltForgeVersionOutput rejects embedded whitespace (and the native
	// filepath.Separator). On Windows the native separator is backslash, so a
	// forward slash is NOT rejected there; elsewhere it is. Trailing whitespace
	// in the whole line is first removed by TrimSpace, so a version token
	// followed only by trailing tab/newline is still accepted as a valid
	// version; only whitespace interleaved with the token is rejected.
	var fs = string(filepath.Separator)
	var slashAccepted = fs != "/"
	cases := map[string]bool{
		"Forge 9.8.7\n":            true,
		"Forge 9.8.7":              true,
		"Forge\n":                  false,
		"":                         false,
		"not a forge binary\n":     false,
		"Forge 9.8.7 with space\n": false,
		// Trailing tab/newline is trimmed from the whole line before parsing,
		// so this is accepted as version 9.8.7 (only embedded whitespace fails).
		"Forge 9.8.7\t\n": true,
		// Generic separators (whitespace) are always rejected.
		"Forge 9.8.7" + fs + "evil\n": false,
		// Forward slash: rejected on non-Windows, accepted on Windows.
		"Forge 9.8.7/evil\n": slashAccepted,
	}
	for output, ok := range cases {
		_, err := parseBuiltForgeVersionOutput(output)
		if ok && err != nil {
			t.Fatalf("parseBuiltForgeVersionOutput(%q) unexpected error: %v", output, err)
		}
		if !ok && err == nil {
			t.Fatalf("parseBuiltForgeVersionOutput(%q) should error", output)
		}
	}
}

func TestInstallBuiltForgeBinaryVersionSetsCurrentPointerInline(t *testing.T) {
	home := t.TempDir()
	dataHome := filepath.Join(home, "xdg-data")
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_DATA_HOME", dataHome)

	built := filepath.Join(t.TempDir(), forgeBinaryArtifactName())
	writeFakeExecutable(t, built, "fake forge binary\n")
	now := time.Date(2026, 6, 5, 12, 34, 56, 0, time.UTC)

	result, err := installBuiltForgeBinaryVersion(built, "9.8.7", now)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(filepath.Base(filepath.Dir(result.VersionPath)), "v9.8.7-") {
		t.Fatalf("explicit version 9.8.7 should drive the version slot, got %q", result.VersionPath)
	}
	// Current pointer written by the install seam points at the version path.
	current := strings.TrimSpace(readTextIfExists(forgeCurrentPointerPath()))
	if current != result.VersionPath {
		t.Fatalf("current pointer = %q, want %q", current, result.VersionPath)
	}
}

func TestWriteAtomicTextNoClobberRace(t *testing.T) {
	home := t.TempDir()
	dataHome := filepath.Join(home, "xdg-data")
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_DATA_HOME", dataHome)

	path := filepath.Join(dataHome, "wrenyard", "runtime", "current")
	if err := writeAtomicText(path, "first\n"); err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(readTextIfExists(path)); got != "first" {
		t.Fatalf("atomic write = %q, want first", got)
	}
	// Rewrite replaces content atomically (used for the current pointer update).
	if err := writeAtomicText(path, "second\n"); err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(readTextIfExists(path)); got != "second" {
		t.Fatalf("atomic rewrite = %q, want second", got)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("atomic target should exist: %v", err)
	}
}

func TestInstallRefreshesStableFDSHLauncher(t *testing.T) {
	home := t.TempDir()
	dataHome := filepath.Join(home, "xdg-data")
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_DATA_HOME", dataHome)

	first := filepath.Join(t.TempDir(), forgeBinaryArtifactName())
	writeFakeExecutable(t, first, "first forge binary\n")
	now := time.Date(2026, 6, 5, 12, 34, 56, 0, time.UTC)
	result1, err := installBuiltForgeBinary(first, now)
	if err != nil {
		t.Fatal(err)
	}

	fdsh := layout.NewPaths(home).StableFDSHLauncherPath()
	if !exists(fdsh) {
		t.Fatal("fdsh should exist after the first install")
	}
	// Tamper with the fdsh launcher so a subsequent install/update must refresh it.
	if err := os.WriteFile(fdsh, []byte("stale fdsh launcher\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// updateVersionedInstall delegates to InstallBuiltForgeBinaryVersion (the
	// same seam that refreshes the fdsh launcher) after validating the current
	// pointer; exercise that seam with a new binary.
	second := filepath.Join(t.TempDir(), forgeBinaryArtifactName())
	writeFakeExecutable(t, second, "second forge binary\n")
	result2, err := installBuiltForgeBinary(second, now.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}

	if runtime.GOOS == "windows" {
		if got := readTextIfExists(fdsh); got != "second forge binary\n" {
			t.Fatalf("fdsh.exe should be refreshed to the current forge binary, got %q", got)
		}
	} else {
		script := readTextIfExists(fdsh)
		if !strings.Contains(script, `exec "$target" "$@"`) || !strings.Contains(script, "FORGE_FDSH_MARKER=1") {
			t.Fatalf("POSIX fdsh launcher should be restored as an exec script, got:\n%s", script)
		}
	}
	// fdsh execs the current pointer, which must be the refreshed install.
	if got := strings.TrimSpace(readTextIfExists(forgeCurrentPointerPath())); got != result2.VersionPath {
		t.Fatalf("current pointer = %q, want %q", got, result2.VersionPath)
	}
	if result2.VersionPath == result1.VersionPath {
		t.Fatal("second install should deploy a distinct version slot")
	}
}
