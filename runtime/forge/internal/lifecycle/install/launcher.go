package install

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/lifecycle/layout"
)

// --- Stable launcher creation ---

// EnsureStableForgeLauncher creates or preserves the stable launcher script or
// binary at the standard path, returning (stablePath, deferredPath, error).
func EnsureStableForgeLauncher(home string, binaryPath string) (string, string, error) {
	lp := layout.NewPaths(home)
	stablePath := lp.StableForgeLauncherPath()
	if err := os.MkdirAll(filepath.Dir(stablePath), 0o755); err != nil {
		return "", "", err
	}
	if runtime.GOOS != "windows" {
		if err := os.WriteFile(stablePath, []byte(PosixStableForgeLauncherScript()), 0o755); err != nil {
			return "", "", err
		}
		return stablePath, "", nil
	}
	if lp.StableForgeLauncherReady() {
		return stablePath, "", nil
	}
	if err := copyFile(binaryPath, stablePath); err != nil {
		deferredPath := stablePath + ".launcher.new"
		if fallbackErr := copyFile(binaryPath, deferredPath); fallbackErr != nil {
			return "", "", err
		}
		return stablePath, deferredPath, nil
	}
	if err := MarkStableForgeLauncherReady(lp); err != nil {
		return "", "", err
	}
	return stablePath, "", nil
}

// PosixStableForgeLauncherScript returns the POSIX launcher shell script.
func PosixStableForgeLauncherScript() string {
	return `#!/bin/sh
set -eu
data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
current_file="$data_home/wrenyard/runtime/current"
target="$(cat "$current_file")"
exec "$target" "$@"
`
}

// MarkStableForgeLauncherReady writes the readiness marker.
func MarkStableForgeLauncherReady(lp layout.Paths) error {
	return writeAtomicText(lp.StableForgeLauncherMarkerPath(), lp.StableForgeLauncherPath()+"\n")
}

// EnsureStableFDSHLauncher creates or refreshes the stable fdsh launcher at the
// standard path, returning (fdshPath, deferredPath, error). POSIX writes an
// exec script that reads the Forge current pointer and re-execs the current
// Forge target with the hidden FORGE_FDSH_MARKER; Windows copies the current
// Forge binary as fdsh.exe so basename dispatch reaches the same code path.
func EnsureStableFDSHLauncher(home string, binaryPath string) (string, string, error) {
	lp := layout.NewPaths(home)
	fdshPath := lp.StableFDSHLauncherPath()
	if err := os.MkdirAll(filepath.Dir(fdshPath), 0o755); err != nil {
		return "", "", err
	}
	if runtime.GOOS != "windows" {
		if err := os.WriteFile(fdshPath, []byte(PosixStableFDSHLauncherScript()), 0o755); err != nil {
			return "", "", err
		}
		return fdshPath, "", nil
	}
	if sameFileHash(fdshPath, binaryPath) {
		return fdshPath, "", nil
	}
	if err := copyFile(binaryPath, fdshPath); err != nil {
		deferredPath := fdshPath + ".new"
		if fallbackErr := copyFile(binaryPath, deferredPath); fallbackErr != nil {
			return "", "", err
		}
		return fdshPath, deferredPath, nil
	}
	return fdshPath, "", nil
}

// PosixStableFDSHLauncherScript returns the POSIX fdsh launcher shell script.
// It reads the Forge current pointer and execs the current Forge target with
// the hidden fdsh marker so the versioned binary recognizes the invocation.
func PosixStableFDSHLauncherScript() string {
	return `#!/bin/sh
set -eu
data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
current_file="$data_home/wrenyard/runtime/current"
target="$(cat "$current_file")"
export FORGE_FDSH_MARKER=1
exec "$target" "$@"
`
}

// sameFileHash reports whether two files have the same short content hash.
func sameFileHash(a, b string) bool {
	ah, err := FileSHA256Prefix(a, 12)
	if err != nil {
		return false
	}
	bh, err := FileSHA256Prefix(b, 12)
	if err != nil {
		return false
	}
	return ah == bh
}

// --- Stable launcher dispatch / target selection ---

// RunStableLauncherIfNeeded checks whether the running process is the stable
// launcher and, if so, execs the current versioned binary. Returns the exit
// code and whether a relaunch was performed.
func RunStableLauncherIfNeeded(home string) (int, bool) {
	lp := layout.NewPaths(home)
	exe, err := os.Executable()
	if err != nil {
		return 0, false
	}
	target, ok, err := stableForgeLaunchTargetFor(lp, exe)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1, true
	}
	if !ok {
		return 0, false
	}
	cmd := exec.Command(target, os.Args[1:]...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = os.Environ()
	return exitCode(cmd.Run()), true
}

// StableForgeLaunchTargetFor resolves the versioned binary target for tests
// and root launcher wiring.
func StableForgeLaunchTargetFor(home, exePath string) (string, bool, error) {
	return stableForgeLaunchTargetFor(layout.NewPaths(home), exePath)
}

func stableForgeLaunchTargetFor(lp layout.Paths, exePath string) (string, bool, error) {
	if os.Getenv("FORGE_DISABLE_VERSIONED_LAUNCHER") == "1" {
		return "", false, nil
	}
	exeAbs, err := filepath.Abs(exePath)
	if err != nil {
		return "", false, err
	}
	stableAbs, err := filepath.Abs(lp.StableForgeLauncherPath())
	if err != nil {
		return "", false, err
	}
	if !SamePath(exeAbs, stableAbs) {
		return "", false, nil
	}
	if !lp.StableForgeLauncherReady() {
		return "", false, nil
	}
	target := strings.TrimPrefix(strings.TrimSpace(readTextIfExists(lp.CurrentPointerPath())), "\ufeff")
	if target == "" {
		return "", false, nil
	}
	targetAbs, err := filepath.Abs(target)
	if err != nil {
		return "", false, err
	}
	if SamePath(targetAbs, stableAbs) {
		return "", false, nil
	}
	if !exists(targetAbs) {
		return "", false, fmt.Errorf("forge launcher: current target missing at %s", targetAbs)
	}
	return targetAbs, true, nil
}

// SamePath compares two paths for equality, using case-insensitive comparison
// on Windows.
func SamePath(a, b string) bool {
	a = filepath.Clean(a)
	b = filepath.Clean(b)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}
