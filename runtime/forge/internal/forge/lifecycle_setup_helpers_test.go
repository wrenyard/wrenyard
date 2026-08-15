package forge

import (
	"time"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/lifecycle/install"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/lifecycle/layout"
)

// forgeBinaryInstallResult is an alias for install.InstallResult, used by
// tests that reference the install-built-forge-binary outcome.
type forgeBinaryInstallResult = install.InstallResult

func ensureGitignoreEntry(gitignorePath, entry string) error {
	return install.EnsureGitignoreEntry(gitignorePath, entry)
}

func installBuiltForgeBinary(binaryPath string, now time.Time) (install.InstallResult, error) {
	return install.InstallBuiltForgeBinaryVersion(userHome(), binaryPath, version, now)
}

func installBuiltForgeBinaryVersion(binaryPath string, targetVersion string, now time.Time) (install.InstallResult, error) {
	return install.InstallBuiltForgeBinaryVersion(userHome(), binaryPath, targetVersion, now)
}

func writeAtomicText(path, content string) error {
	return install.WriteAtomicText(path, content)
}

func markStableForgeLauncherReady(_ string) error {
	return install.MarkStableForgeLauncherReady(layout.NewPaths(userHome()))
}

func stableForgeLaunchTargetFor(exePath string) (string, bool, error) {
	return install.StableForgeLaunchTargetFor(userHome(), exePath)
}

func parseBuiltForgeVersionOutput(output string) (string, error) {
	return install.ParseBuiltForgeVersionOutput(output)
}

func forgeVersionIDVersion(ver string, binaryPath string, now time.Time) (string, error) {
	return install.ForgeVersionIDVersion(userHome(), binaryPath, ver, now)
}

func fileSHA256Prefix(path string, prefix int) (string, error) {
	return install.FileSHA256Prefix(path, prefix)
}

func versionIDHash(versionID string) string {
	return install.VersionIDHash(versionID)
}

func versionPathMatchesForgeVersion(binaryPath, targetVersion string) bool {
	return install.VersionPathMatchesForgeVersion(binaryPath, targetVersion)
}
