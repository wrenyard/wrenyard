package install

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/lifecycle/layout"
)

// InstallBuiltForgeBinary installs a built forge binary into the versioned
// layout using the current version.
func InstallBuiltForgeBinary(home string, binaryPath string, now time.Time) (InstallResult, error) {
	return InstallBuiltForgeBinaryVersion(home, binaryPath, "", now)
}

// InstallBuiltForgeBinaryVersion installs a built forge binary into the
// versioned layout for the given target version (uses deps.Version() when
// targetVersion is empty).
func InstallBuiltForgeBinaryVersion(home string, binaryPath string, targetVersion string, now time.Time) (InstallResult, error) {
	versionID, err := ForgeVersionIDVersion(home, binaryPath, targetVersion, now)
	if err != nil {
		return InstallResult{}, err
	}
	lp := layout.NewPaths(home)
	versionPath := filepath.Join(lp.VersionsDir(), versionID, lp.BinaryArtifactName())
	if err := os.MkdirAll(filepath.Dir(versionPath), 0o755); err != nil {
		return InstallResult{}, err
	}
	if err := copyFile(binaryPath, versionPath); err != nil {
		return InstallResult{}, err
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(versionPath, 0o755); err != nil {
			return InstallResult{}, err
		}
	}

	// Deploy self-assertion: verify the deployed binary matches the source.
	sourceHash, err := FileSHA256Prefix(binaryPath, 12)
	if err != nil {
		return InstallResult{}, fmt.Errorf("deploy assertion: compute source hash: %w", err)
	}
	targetHash, err := FileSHA256Prefix(versionPath, 12)
	if err != nil {
		return InstallResult{}, fmt.Errorf("deploy assertion: compute target hash: %w", err)
	}
	if sourceHash != targetHash {
		return InstallResult{}, fmt.Errorf("deploy FAILED: binary hash mismatch (source %s, target %s); the deployed binary at %s does not match the build", sourceHash, targetHash, versionPath)
	}

	stablePath, deferredPath, err := EnsureStableForgeLauncher(home, binaryPath)
	if err != nil {
		return InstallResult{}, err
	}
	fdshPath, fdshDeferredPath, err := EnsureStableFDSHLauncher(home, binaryPath)
	if err != nil {
		return InstallResult{}, err
	}
	if err := writeAtomicText(lp.CurrentPointerPath(), versionPath+"\n"); err != nil {
		return InstallResult{}, err
	}

	// Re-verify current pointer after write.
	currentTarget := strings.TrimSpace(readTextIfExists(lp.CurrentPointerPath()))
	if currentTarget == "" || currentTarget != versionPath {
		return InstallResult{}, fmt.Errorf("deploy FAILED: current pointer verification failed; expected %s", versionPath)
	}

	deployedHash := versionIDHash(versionID)
	fmt.Printf("deployed %s %s -> %s\n", targetVersion, deployedHash, versionPath)
	return InstallResult{VersionID: versionID, VersionPath: versionPath, StableLauncherPath: stablePath, StableLauncherDeferredPath: deferredPath, StableFDSHLauncherPath: fdshPath, StableFDSHLauncherDeferredPath: fdshDeferredPath}, nil
}

// ForgeVersionID builds a version ID from path+version+timestamp.
func ForgeVersionID(home string, binaryPath string, now time.Time) (string, error) {
	return ForgeVersionIDVersion(home, binaryPath, "", now)
}

// ForgeVersionIDVersion builds a version ID using an explicit version string.
func ForgeVersionIDVersion(home string, binaryPath string, ver string, now time.Time) (string, error) {
	hash, err := FileSHA256Prefix(binaryPath, 12)
	if err != nil {
		return "", err
	}
	now = now.UTC()
	stamp := fmt.Sprintf("%s%09dZ", now.Format("20060102T150405"), now.Nanosecond())
	return "v" + ver + "-" + stamp + "-" + hash, nil
}

// VersionIDHash extracts a short hash from a version ID string.
func VersionIDHash(versionID string) string {
	parts := strings.Split(versionID, "-")
	if len(parts) > 0 {
		return parts[len(parts)-1]
	}
	return ""
}

// versionIDHash is the internal alias; exported for tests that may call through root.
func versionIDHash(versionID string) string { return VersionIDHash(versionID) }

// ParseBuiltForgeVersionOutput parses the stdout of a freshly built Forge
// binary run with --version. Accepts exactly a trimmed line beginning with
// "Forge " followed by a non-empty version token.
func ParseBuiltForgeVersionOutput(output string) (string, error) {
	line := strings.TrimSpace(output)
	if !strings.HasPrefix(line, "Forge ") {
		return "", fmt.Errorf("unrecognized version output: %q", line)
	}
	ver := strings.TrimSpace(strings.TrimPrefix(line, "Forge "))
	if ver == "" {
		return "", fmt.Errorf("empty version token in output: %q", line)
	}
	if strings.ContainsAny(ver, " \t\n\r"+string(filepath.Separator)) {
		return "", fmt.Errorf("invalid version token: %q", ver)
	}
	return ver, nil
}

// BuiltForgeBinaryVersion executes the freshly built binary with --version and
// parses its stdout to determine the deployed Forge version.
func BuiltForgeBinaryVersion(binaryPath string) (string, error) {
	cmd := exec.Command(binaryPath, "--version")
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("run built binary --version: %w", err)
	}
	ver, err := ParseBuiltForgeVersionOutput(string(out))
	if err != nil {
		return "", fmt.Errorf("parse built binary version: %w", err)
	}
	return ver, nil
}

// VersionPathMatchesForgeVersion reports whether binaryPath sits inside the
// version directory for the given Forge version (parent dir prefix "v<ver>-").
func VersionPathMatchesForgeVersion(binaryPath, targetVersion string) bool {
	parent := filepath.Base(filepath.Dir(binaryPath))
	return strings.HasPrefix(parent, "v"+targetVersion+"-")
}

// UpdateVersionedInstall installs the freshly built binary into the versioned
// layout, updating the current pointer and stable launcher.
func UpdateVersionedInstall(home string, binPath string) error {
	return UpdateVersionedInstallVersion(home, binPath, "")
}

// UpdateVersionedInstallVersion installs the freshly built binary into the
// versioned layout, updating the current pointer and stable launcher. When
// targetVersion is nonempty it is used directly; otherwise the version is
// determined by executing the binary with --version.
func UpdateVersionedInstallVersion(home string, binPath string, targetVersion string) error {
	if !exists(binPath) {
		return fmt.Errorf("binary not found at %s", binPath)
	}

	// Determine the target version from the freshly built binary when not provided.
	if targetVersion == "" {
		var err error
		targetVersion, err = BuiltForgeBinaryVersion(binPath)
		if err != nil {
			return err
		}
	}

	lp := layout.NewPaths(home)
	if lp.StableForgeLauncherReady() {
		current := strings.TrimSpace(readTextIfExists(lp.CurrentPointerPath()))
		if current != "" {
			if currentHash, err := FileSHA256Prefix(current, 12); err == nil {
				if binHash, err := FileSHA256Prefix(binPath, 12); err == nil && currentHash == binHash {
					if VersionPathMatchesForgeVersion(current, targetVersion) {
						fmt.Printf("  versioned install already current\n")
						if _, _, err := EnsureStableFDSHLauncher(home, current); err != nil {
							return err
						}
						return nil
					}
				}
			}
		}
	}

	result, err := InstallBuiltForgeBinaryVersion(home, binPath, targetVersion, time.Now().UTC())
	if err != nil {
		return err
	}

	fmt.Printf("  installed %s\n", result.VersionPath)
	if result.StableLauncherDeferredPath != "" {
		fmt.Fprintf(os.Stderr, "  stable launcher locked; wrote replacement to %s. Stop running forge processes and replace %s with it.\n",
			result.StableLauncherDeferredPath, result.StableLauncherPath)
	}
	return nil
}

// --- file helpers (local copies; no root dependency) ---

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func readTextIfExists(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(data)
}

func copyFile(src, dst string) error {
	b, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, b, 0o644)
}

// WriteAtomicText writes content to path atomically using a temp file.
// The parent directory is created automatically; on Windows the existing
// target file is removed before rename.
func WriteAtomicText(path, content string) error {
	return writeAtomicText(path, content)
}

func writeAtomicText(path, content string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o644); err != nil {
		return err
	}
	if runtime.GOOS == "windows" && exists(path) {
		if err := os.Remove(path); err != nil {
			_ = os.Remove(tmp)
			return err
		}
	}
	return os.Rename(tmp, path)
}

// runGoBuild runs go build for the repo binary.
func RunGoBuild(repo, binPath string) error {
	if err := os.MkdirAll(filepath.Dir(binPath), 0o755); err != nil {
		return err
	}
	cmd := exec.Command("go", "build", "-o", binPath, "./cmd/forge")
	cmd.Dir = repo
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// ExitCode extracts the exit code from an error (or returns 0 for nil).
func ExitCode(err error) int {
	if err == nil {
		return 0
	}
	if exitErr, ok := err.(*exec.ExitError); ok {
		return exitErr.ExitCode()
	}
	return 1
}

// exitCode is the internal alias.
func exitCode(err error) int { return ExitCode(err) }
