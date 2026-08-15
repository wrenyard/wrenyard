package doctor

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func grokTestDeps(binaryInstalled bool, resolve func(string) (string, bool)) Dependencies {
	return Dependencies{
		GrokBinaryInstalled: func() bool { return binaryInstalled },
		ResolveCredential:   resolve,
	}
}

func TestGrokDoctorCheckSurface(t *testing.T) {
	// Reset XDG so paths resolve into the temp home.
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	mkdirAll(t, filepath.Join(home, ".grok"))
	writeFile(t, filepath.Join(home, ".grok", "auth.json"), "oauth fixture bytes")

	resolve := func(id string) (string, bool) {
		if id == "kimi-coding" || id == "zhipu-coding" {
			return "present", true
		}
		return "", false
	}

	check := GrokDoctorCheck(grokTestDeps(true, resolve))
	if check["adapter"] != "grok" {
		t.Fatalf("adapter = %v", check["adapter"])
	}
	if check["status"] != "ok" {
		t.Fatalf("expected ok when binary present and overlay valid, got %v: %v", check["status"], check["message"])
	}
	details, ok := check["details"].(map[string]interface{})
	if !ok {
		t.Fatalf("missing details: %#v", check)
	}
	if details["binary_installed"] != true || details["agent_parent_writable"] != true || details["xai_oauth_available"] != true {
		t.Fatalf("expected healthy binary, agent parent, and xAI OAuth checks: %#v", details)
	}
	eligible, ok := details["eligible_models"].([]map[string]interface{})
	if !ok || len(eligible) == 0 {
		t.Fatalf("expected eligible models in details: %#v", details)
	}
	// Eligible entries must carry env_key but never a credential value.
	for _, e := range eligible {
		if e["env_key"] == nil {
			t.Fatalf("eligible entry missing env_key: %#v", e)
		}
		if strings.Contains(asString(e["env_key"]), "OPENAI_API_KEY") {
			t.Fatalf("eligible entry must not use OPENAI_API_KEY: %#v", e)
		}
	}
}

func TestGrokDoctorCheckMissingBinaryWarns(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	check := GrokDoctorCheck(grokTestDeps(false, func(string) (string, bool) { return "", false }))
	if check["status"] != "warning" {
		t.Fatalf("missing grok binary should warn, got %v: %v", check["status"], check["message"])
	}
}

func TestGrokDoctorCheckInvalidOverlayErrors(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	cfgHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", cfgHome)
	// Write an invalid overlay containing api_key.
	overlayDir := filepathJoin(cfgHome, "forge", "grok")
	mkdirAll(t, overlayDir)
	writeFile(t, filepathJoin(overlayDir, "overlay.toml"), "api_key = \"leaked\"\n")

	check := GrokDoctorCheck(grokTestDeps(true, func(string) (string, bool) { return "", false }))
	if check["status"] != "error" {
		t.Fatalf("invalid overlay should error, got %v: %v", check["status"], check["message"])
	}
}

func TestGrokDoctorCheckGrokHomeIsFile(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	// Replace GROK_HOME with a regular file (not a directory).
	dataHome := t.TempDir()
	t.Setenv("XDG_DATA_HOME", dataHome)
	grokHome := filepath.Join(dataHome, "forge", "grok", "shell-grok")
	mkdirAll(t, filepath.Dir(grokHome))
	writeFile(t, grokHome, "this is a file, not a directory\n")

	check := GrokDoctorCheck(grokTestDeps(true, func(string) (string, bool) { return "", false }))
	if check["status"] != "error" {
		t.Fatalf("GROK_HOME as file should error, got %v: %v", check["status"], check["message"])
	}
	message := asString(check["message"])
	if !strings.Contains(message, "not a directory") {
		t.Fatalf("expected directory complaint, got: %v", check["message"])
	}
}

func TestGrokDoctorCheckMalformedConfig(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	dataHome := t.TempDir()
	t.Setenv("XDG_DATA_HOME", dataHome)
	configDir := filepath.Join(dataHome, "forge", "grok", "shell-grok")
	mkdirAll(t, configDir)
	writeFile(t, filepath.Join(configDir, "config.toml"), "this is = = not valid toml\n")

	check := GrokDoctorCheck(grokTestDeps(true, func(string) (string, bool) { return "", false }))
	if check["status"] != "error" {
		t.Fatalf("malformed config should error, got %v: %v", check["status"], check["message"])
	}
	message := asString(check["message"])
	if !strings.Contains(message, "not valid") {
		t.Fatalf("expected config validity complaint, got: %v", check["message"])
	}
}

func TestGrokDoctorCheckAbsentGrokHomeIsOk(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	check := GrokDoctorCheck(grokTestDeps(true, func(string) (string, bool) { return "", false }))
	// With binary present and absent GROK_HOME, doctor should still be ok
	// because GROK_HOME will be created on first materialize.
	details := check["details"].(map[string]interface{})
	if details["grok_home"] == "" {
		t.Fatalf("grok_home must be populated")
	}
	// Status is not error; absent GROK_HOME is tolerated.
	if check["status"] == "error" {
		t.Fatalf("absent GROK_HOME should not error: %v: %v", check["status"], check["message"])
	}
}

func TestGrokDoctorCheckConfigApiKeyRejectedAndNotModified(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	dataHome := t.TempDir()
	t.Setenv("XDG_DATA_HOME", dataHome)
	configDir := filepath.Join(dataHome, "forge", "grok", "shell-grok")
	mkdirAll(t, configDir)
	cfgPath := filepath.Join(configDir, "config.toml")
	writeFile(t, cfgPath, "[auth]\napi_key = \"secret\"\n[models]\ndefault = \"x\"\n")
	origInfo, _ := os.Stat(cfgPath)
	origBytes, _ := os.ReadFile(cfgPath)

	check := GrokDoctorCheck(grokTestDeps(true, func(string) (string, bool) { return "", false }))
	if check["status"] != "error" {
		t.Fatalf("config with api_key should error, got %v: %v", check["status"], check["message"])
	}
	message := asString(check["message"])
	if !strings.Contains(message, "api_key") || strings.Contains(message, "secret") {
		t.Fatalf("expected redacted api_key error, got: %v", check["message"])
	}
	// Must not modify the config.
	info2, _ := os.Stat(cfgPath)
	if !origInfo.ModTime().Equal(info2.ModTime()) {
		t.Fatal("doctor must not modify config file with api_key")
	}
	currentBytes, _ := os.ReadFile(cfgPath)
	if string(currentBytes) != string(origBytes) {
		t.Fatal("doctor must not modify config file bytes")
	}
}

func TestGrokDoctorCheckDoesNotCreatePaths(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	dataHome := t.TempDir()
	t.Setenv("XDG_DATA_HOME", dataHome)

	// The expected GROK_HOME directory does not exist yet.
	grokHome := filepath.Join(dataHome, "forge", "grok", "shell-grok")
	check := GrokDoctorCheck(grokTestDeps(true, func(string) (string, bool) { return "", false }))
	// Doctor must not have created the directory.
	if _, err := os.Stat(grokHome); err == nil {
		t.Fatalf("doctor must not create GROK_HOME: %s", grokHome)
	}
	// Status must not be error (absent is fine).
	if check["status"] == "error" {
		t.Fatalf("absent GROK_HOME should not error: %v: %v", check["status"], check["message"])
	}
}

func TestGrokDoctorCheckGrokHomeInaccessible(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	dataHome := t.TempDir()
	t.Setenv("XDG_DATA_HOME", dataHome)

	// Block GROK_HOME traversal by replacing a parent component with a regular
	// file. GROK_HOME resolves to dataHome/forge/grok/shell-grok; making
	// dataHome/forge/grok a file causes os.Stat to fail with ENOTDIR.
	grokDir := filepath.Join(dataHome, "forge", "grok")
	mkdirAll(t, filepath.Dir(grokDir))
	if err := os.WriteFile(grokDir, []byte("i block the directory"), 0o644); err != nil {
		t.Fatal(err)
	}

	check := GrokDoctorCheck(grokTestDeps(true, func(string) (string, bool) { return "", false }))
	if check["status"] != "error" {
		t.Fatalf("inaccessible GROK_HOME should error, got %v: %v", check["status"], check["message"])
	}
	message := asString(check["message"])
	if !strings.Contains(message, "inaccessible") {
		t.Fatalf("expected inaccessible complaint, got: %v", check["message"])
	}
	// Doctor must not create any directories.
	if _, err := os.Stat(dataHome); err != nil {
		t.Fatalf("doctor must not create directories: %v", err)
	}
}

func TestGrokDoctorCheckConfigInaccessible(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows does not enforce POSIX directory mode bits")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	dataHome := t.TempDir()
	t.Setenv("XDG_DATA_HOME", dataHome)
	configDir := filepath.Join(dataHome, "forge", "grok", "shell-grok")
	mkdirAll(t, configDir)
	writeFile(t, filepath.Join(configDir, "config.toml"), "key = \"val\"\n")

	// Make config parent directory non-searchable, causing os.Stat on the
	// config file to fail with EACCES.
	if err := os.Chmod(configDir, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(configDir, 0o700) })

	check := GrokDoctorCheck(grokTestDeps(true, func(string) (string, bool) { return "", false }))
	if check["status"] != "error" {
		t.Fatalf("inaccessible config should error, got %v: %v", check["status"], check["message"])
	}
	message := asString(check["message"])
	if !strings.Contains(message, "inaccessible") {
		t.Fatalf("expected inaccessible complaint, got: %v", check["message"])
	}
}

func asString(v interface{}) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func filepathJoin(parts ...string) string { return filepath.Join(parts...) }

func mkdirAll(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}
