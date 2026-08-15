package driver

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

const hermeticTestCredential = "selected-provider-credential-sentinel"

func TestRestrictedRipgrepIgnoresInheritedPreprocessorConfig(t *testing.T) {
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skipf("rg unavailable: %v", err)
	}
	root := t.TempDir()
	sentinel := filepath.Join(root, "rg-helper-ran")
	helper := writeHermeticHelper(t, root, "rg-pre", sentinel, true)
	config := filepath.Join(root, "ripgrep.conf")
	configData := "--pre=" + filepath.ToSlash(helper) + "\n--pre-glob=*\n"
	if err := os.WriteFile(config, []byte(configData), 0o600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "input.txt")
	if err := os.WriteFile(target, []byte("needle\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	planned := map[string]string{
		"FORGE_SELECTED_CREDENTIAL": hermeticTestCredential,
	}
	t.Setenv("RIPGREP_CONFIG_PATH", config)

	runCommandWithPermission(t, root, planned, catalog.PermissionReadonly, "rg", "needle", target)
	assertHelperDidNotRun(t, sentinel)
	runCommandWithPermission(t, root, planned, catalog.PermissionYolo, "rg", "needle", target)
	assertHelperCredential(t, sentinel)
}

func TestRestrictedGitStatusCannotExecuteConfiguredHelpers(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git unavailable: %v", err)
	}
	for _, source := range []string{"environment", "global", "repository"} {
		t.Run(source, func(t *testing.T) {
			root := t.TempDir()
			repo := filepath.Join(root, "repo")
			runPlain(t, root, nil, "git", "init", "-q", repo)
			if err := os.WriteFile(filepath.Join(repo, "tracked.txt"), []byte("tracked\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			runPlain(t, root, nil, "git", "-C", repo, "add", "tracked.txt")

			sentinel := filepath.Join(root, source+"-helper-ran")
			helper := writeHermeticHelper(t, root, source+"-fsmonitor", sentinel, false)
			planned := map[string]string{"FORGE_SELECTED_CREDENTIAL": hermeticTestCredential}
			switch source {
			case "environment":
				t.Setenv("GIT_CONFIG_COUNT", "1")
				t.Setenv("GIT_CONFIG_KEY_0", "core.fsmonitor")
				t.Setenv("GIT_CONFIG_VALUE_0", filepath.ToSlash(helper))
			case "global":
				home := filepath.Join(root, "home")
				if err := os.MkdirAll(home, 0o700); err != nil {
					t.Fatal(err)
				}
				planned["HOME"] = home
				planned["USERPROFILE"] = home
				globalEnv := append(os.Environ(), "HOME="+home, "USERPROFILE="+home)
				runPlain(t, root, globalEnv, "git", "config", "--global", "core.fsmonitor", filepath.ToSlash(helper))
			case "repository":
				runPlain(t, root, nil, "git", "-C", repo, "config", "core.fsmonitor", filepath.ToSlash(helper))
			}

			runCommandWithPermission(t, repo, planned, catalog.PermissionReadonly, "git", "--no-optional-locks", "status", "--short")
			assertHelperDidNotRun(t, sentinel)
			runCommandWithPermission(t, repo, planned, catalog.PermissionYolo, "git", "--no-optional-locks", "status", "--short")
			assertHelperCredential(t, sentinel)
		})
	}
}

func TestRestrictedChildStripsInheritedGitExternalDiff(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git unavailable: %v", err)
	}
	root := t.TempDir()
	repo := filepath.Join(root, "repo")
	runPlain(t, root, nil, "git", "init", "-q", repo)
	tracked := filepath.Join(repo, "tracked.txt")
	if err := os.WriteFile(tracked, []byte("first\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runPlain(t, root, nil, "git", "-C", repo, "add", "tracked.txt")
	runPlain(t, root, nil, "git", "-C", repo, "-c", "user.name=Forge Test", "-c", "user.email=forge@example.invalid", "commit", "-qm", "fixture")
	if err := os.WriteFile(tracked, []byte("second\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	sentinel := filepath.Join(root, "external-diff-ran")
	helper := writeHermeticHelper(t, root, "external-diff", sentinel, false)
	t.Setenv("GIT_EXTERNAL_DIFF", filepath.ToSlash(helper))
	planned := map[string]string{"FORGE_SELECTED_CREDENTIAL": hermeticTestCredential}

	runCommandWithPermission(t, repo, planned, catalog.PermissionReadonly, "git", "--no-optional-locks", "diff")
	assertHelperDidNotRun(t, sentinel)
	runCommandWithPermission(t, repo, planned, catalog.PermissionYolo, "git", "--no-optional-locks", "diff")
	assertHelperCredential(t, sentinel)
}

func writeHermeticHelper(t *testing.T, root, name, sentinel string, copyInput bool) string {
	t.Helper()
	path := filepath.Join(root, name)
	var body string
	if runtime.GOOS == "windows" {
		path += ".cmd"
		body = "@echo off\r\n>\"" + sentinel + "\" echo %FORGE_SELECTED_CREDENTIAL%\r\n"
		if copyInput {
			body += "type \"%~1\"\r\n"
		}
		body += "exit /b 0\r\n"
	} else {
		body = "#!/bin/sh\nprintf '%s' \"$FORGE_SELECTED_CREDENTIAL\" > '" + strings.ReplaceAll(sentinel, "'", "'\\''") + "'\n"
		if copyInput {
			body += "cat \"$1\"\n"
		}
	}
	if err := os.WriteFile(path, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}

func runCommandWithPermission(t *testing.T, dir string, planned map[string]string, permission catalog.PermissionMode, name string, args ...string) {
	t.Helper()
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	cmd.Env = BuildChildEnvForPermission(planned, permission)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%s %v failed: %v\n%s", name, args, err, output)
	}
}

func runPlain(t *testing.T, dir string, env []string, name string, args ...string) {
	t.Helper()
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	if env != nil {
		cmd.Env = env
	}
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%s %v failed: %v\n%s", name, args, err, output)
	}
}

func assertHelperDidNotRun(t *testing.T, sentinel string) {
	t.Helper()
	if data, err := os.ReadFile(sentinel); err == nil {
		t.Fatalf("restricted command executed helper with contents %q", data)
	} else if !os.IsNotExist(err) {
		t.Fatal(err)
	}
}

func assertHelperCredential(t *testing.T, sentinel string) {
	t.Helper()
	data, err := os.ReadFile(sentinel)
	if err != nil {
		t.Fatalf("yolo did not preserve configured helper behavior: %v", err)
	}
	if strings.TrimSpace(string(data)) != hermeticTestCredential {
		t.Fatalf("configured helper received %q, want selected credential sentinel", strings.TrimSpace(string(data)))
	}
}
