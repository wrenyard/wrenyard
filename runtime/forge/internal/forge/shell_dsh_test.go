package forge

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/dsh"
)

// writeFakeDSH creates an executable fake dsh dialect that reports the given
// protocol line for --version and, for real launches, appends its argv and
// environment to the file named by FDSH_TEST_OUT.
func writeFakeDSH(t *testing.T, protocolLine string) (bin, outFile string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake dsh shell script requires a POSIX shell")
	}
	dir := t.TempDir()
	bin = filepath.Join(dir, "dsh")
	outFile = filepath.Join(dir, "dsh-out.txt")
	script := "#!/bin/sh\n" +
		"if [ \"$1\" = \"--version\" ]; then\n" +
		"  printf '%s\\n' \"" + protocolLine + "\"\n" +
		"  exit 0\n" +
		"fi\n" +
		"printf 'args:' >> \"$FDSH_TEST_OUT\"\n" +
		"for a in \"$@\"; do printf ' [%s]' \"$a\" >> \"$FDSH_TEST_OUT\"; done\n" +
		"printf '\\n' >> \"$FDSH_TEST_OUT\"\n" +
		"env >> \"$FDSH_TEST_OUT\"\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FDSH_TEST_OUT", outFile)
	return bin, outFile
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func fdshLauncherTestEnv(t *testing.T, home string) {
	t.Helper()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_DATA_HOME", filepath.Join(home, "xdg-data"))
	t.Setenv("DSH_HOME", "")
	t.Setenv("WRENYARD_GATEWAY_OPENAI_CHAT_URL", "http://127.0.0.1:8787/gateway/openai-chat/v1")
	t.Setenv("WRENYARD_GATEWAY_TOKEN", "local-gateway-token")
	t.Setenv("WRENYARD_GATEWAY_MODELS_JSON", `[{"id":"hy4-preview-ioa","publicId":"codebuddy/hy4-preview-ioa","provider":"codebuddy","displayName":"HY4 Preview"}]`)
}

func TestFDSHRequested(t *testing.T) {
	t.Setenv("FORGE_FDSH_MARKER", "")
	if fdshRequested() {
		t.Fatal("fdshRequested should be false without the marker or an fdsh basename")
	}
	t.Setenv("FORGE_FDSH_MARKER", "1")
	if !fdshRequested() {
		t.Fatal("fdshRequested should be true with FORGE_FDSH_MARKER=1")
	}
	t.Setenv("FORGE_FDSH_MARKER", "0")
	if fdshRequested() {
		t.Fatal("fdshRequested should be false with FORGE_FDSH_MARKER=0")
	}
}

func TestFDSHDefaultsToWebProfile(t *testing.T) {
	home := t.TempDir()
	fdshLauncherTestEnv(t, home)
	dshBin, outFile := writeFakeDSH(t, "@deepseek-ai/dsh@0.1.0-rc.6")
	t.Setenv("FORGE_DSH_BIN", dshBin)

	plan, err := buildDSHPlan(nil)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Profile != "web" {
		t.Fatalf("fdsh should default to the web profile, got %q", plan.Profile)
	}
	if plan.Mode != "web" {
		t.Fatalf("fdsh default mode should be web, got %q", plan.Mode)
	}
	if want := []string{"--profile", "web", "--patch", plan.PatchPath}; !equalStrings(plan.Args, want) {
		t.Fatalf("fdsh args = %v, want %v", plan.Args, want)
	}
	if plan.DSHHome != filepath.Join(home, ".dsh") {
		t.Fatalf("web dsh home = %q, want %q", plan.DSHHome, filepath.Join(home, ".dsh"))
	}
	if !exists(plan.PatchPath) {
		t.Fatal("model patch should be written before launch")
	}
	if code := execDSHPlan(plan); code != 0 {
		t.Fatalf("execDSHPlan exit = %d, want 0", code)
	}
	out := readTextIfExists(outFile)
	if !strings.Contains(out, "[--profile] [web]") {
		t.Fatalf("real dsh should receive --profile web, got:\n%s", out)
	}
}

func TestFDSHExplicitProfilePreserved(t *testing.T) {
	home := t.TempDir()
	fdshLauncherTestEnv(t, home)
	dshBin, _ := writeFakeDSH(t, "@deepseek-ai/dsh@0.1.0-rc.6")
	t.Setenv("FORGE_DSH_BIN", dshBin)

	plan, err := buildDSHPlan([]string{"--profile", "custom", "go"})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Profile != "custom" {
		t.Fatalf("explicit profile should be preserved, got %q", plan.Profile)
	}
	if want := []string{"--profile", "custom", "--patch", plan.PatchPath, "go"}; !equalStrings(plan.Args, want) {
		t.Fatalf("args = %v, want %v", plan.Args, want)
	}

	plan, err = buildDSHPlan([]string{"--profile=custom"})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Profile != "custom" {
		t.Fatalf("--profile=custom should set the profile, got %q", plan.Profile)
	}
	if !equalStrings(plan.Args, []string{"--profile", "custom", "--patch", plan.PatchPath}) {
		t.Fatalf("args = %v, want [--profile custom --patch %s]", plan.Args, plan.PatchPath)
	}
}

func TestFDSHForgePatchIsLastPatchBeforeProfileArgs(t *testing.T) {
	home := t.TempDir()
	fdshLauncherTestEnv(t, home)
	dshBin, _ := writeFakeDSH(t, "@deepseek-ai/dsh@0.1.0-rc.6")
	t.Setenv("FORGE_DSH_BIN", dshBin)

	plan, err := buildDSHPlan([]string{"--profile", "headless", "--patch", "user-a.yml", "--patch=user-b.yml", "task"})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"--profile", "headless", "--patch", "user-a.yml", "--patch=user-b.yml", "--patch", plan.PatchPath, "task"}
	if !equalStrings(plan.Args, want) {
		t.Fatalf("args = %v, want %v", plan.Args, want)
	}
}

func TestFDSHHiddenAgentModeRequiresDSHHome(t *testing.T) {
	home := t.TempDir()
	fdshLauncherTestEnv(t, home) // DSH_HOME is explicitly empty here
	dshBin, _ := writeFakeDSH(t, "@deepseek-ai/dsh@0.1.0-rc.6")
	t.Setenv("FORGE_DSH_BIN", dshBin)

	if _, err := buildDSHPlan([]string{"--forge-agent"}); err == nil {
		t.Fatal("--forge-agent without a driver-provided DSH_HOME must fail loudly")
	}
}

func TestFDSHHiddenAgentModeMissingRuntimePatchFails(t *testing.T) {
	home := t.TempDir()
	fdshLauncherTestEnv(t, home)
	driverHome := filepath.Join(home, "dsh-agent-home")
	if err := os.MkdirAll(driverHome, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DSH_HOME", driverHome)
	dshBin, _ := writeFakeDSH(t, "@deepseek-ai/dsh@0.1.0-rc.6")
	t.Setenv("FORGE_DSH_BIN", dshBin)

	if _, err := buildDSHPlan([]string{"--forge-agent"}); err == nil {
		t.Fatal("--forge-agent without an existing runtime patch must fail loudly")
	}
}

func TestFDSHHiddenAgentModeReusesDriverHomeAndPatch(t *testing.T) {
	home := t.TempDir()
	fdshLauncherTestEnv(t, home)
	driverHome := filepath.Join(home, "dsh-agent-home")
	if err := os.MkdirAll(driverHome, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DSH_HOME", driverHome)
	dshBin, outFile := writeFakeDSH(t, "@deepseek-ai/dsh@0.1.0-rc.6")
	t.Setenv("FORGE_DSH_BIN", dshBin)

	// The driver has already rendered the rc.6 runtime patch (and bridge) into
	// the isolated home; forge must reuse it byte-for-byte.
	runtimePatch := filepath.Join(driverHome, dsh.DefaultRuntimePatchAssets().PatchPath)
	sentinel := "# driver-rendered rc.6 runtime patch with bridge\n"
	if err := os.WriteFile(runtimePatch, []byte(sentinel), 0o644); err != nil {
		t.Fatal(err)
	}

	plan, err := buildDSHPlan([]string{"--forge-agent"})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Mode != "agent" {
		t.Fatalf("hidden --forge-agent should select agent mode, got %q", plan.Mode)
	}
	if plan.DSHHome != driverHome {
		t.Fatalf("agent dsh home = %q, want driver-provided %q", plan.DSHHome, driverHome)
	}
	if plan.PatchPath != runtimePatch {
		t.Fatalf("agent patch = %q, want existing driver patch %q", plan.PatchPath, runtimePatch)
	}
	if got := readTextIfExists(runtimePatch); got != sentinel {
		t.Fatalf("--forge-agent must never overwrite the driver patch, got %q", got)
	}
	if exists(filepath.Join(driverHome, dshModelPatchFilename)) {
		t.Fatal("--forge-agent must not maintain the Forge catalog patch")
	}
	for _, arg := range plan.Args {
		if arg == "--forge-agent" {
			t.Fatal("--forge-agent must never be forwarded to the real dsh")
		}
	}
	if want := []string{"--profile", "headless", "--patch", runtimePatch}; !equalStrings(plan.Args, want) {
		t.Fatalf("agent args = %v, want %v", plan.Args, want)
	}
	for _, kv := range plan.Env {
		if strings.HasPrefix(kv, dshModelPatchEnv+"=") {
			t.Fatalf("--forge-agent must not set the Forge catalog patch env, got %s", kv)
		}
	}

	if code := execDSHPlan(plan); code != 0 {
		t.Fatalf("execDSHPlan exit = %d, want 0", code)
	}
	out := readTextIfExists(outFile)
	if !strings.Contains(out, "DSH_HOME="+driverHome) {
		t.Fatalf("child env should carry the reused DSH_HOME, got:\n%s", out)
	}
	if strings.Contains(out, dshModelPatchEnv+"=") {
		t.Fatalf("child env must not contain the Forge catalog patch env, got:\n%s", out)
	}
}

func TestFDSHModelPatchCatalogAndOrder(t *testing.T) {
	home := t.TempDir()
	fdshLauncherTestEnv(t, home)
	dshBin, _ := writeFakeDSH(t, "@deepseek-ai/dsh@0.1.0-rc.6")
	t.Setenv("FORGE_DSH_BIN", dshBin)

	plan, err := buildDSHPlan(nil)
	if err != nil {
		t.Fatal(err)
	}
	patch := readTextIfExists(plan.PatchPath)
	if patch == "" {
		t.Fatal("model patch should not be empty")
	}
	if !strings.HasPrefix(patch, "# forge dsh patch (generated; secret-free)\n- id: llm-pi-ai\n") {
		t.Fatalf("patch must be a loader overlay array:\n%s", patch)
	}
	for _, expected := range []string{"      wrenyard:", "codebuddy/hy4-preview-ioa", "HY4 Preview"} {
		if !strings.Contains(patch, expected) {
			t.Fatalf("patch should reference %s", expected)
		}
	}
}

func TestFDSHChildOnlyCredentials(t *testing.T) {
	home := t.TempDir()
	fdshLauncherTestEnv(t, home)
	dshBin, outFile := writeFakeDSH(t, "@deepseek-ai/dsh@0.1.0-rc.6")
	t.Setenv("FORGE_DSH_BIN", dshBin)

	old := dshCredentialResolver
	dshCredentialResolver = func(providerID string) (dsh.TypedCredential, bool) {
		if providerID != dsh.GatewayProviderID {
			return dsh.TypedCredential{}, false
		}
		return dsh.TypedCredential{Token: "local-gateway-child"}, true
	}
	t.Cleanup(func() { dshCredentialResolver = old })

	plan, err := buildDSHPlan(nil)
	if err != nil {
		t.Fatal(err)
	}
	patch := readTextIfExists(plan.PatchPath)
	value := "local-gateway-child"
	if strings.Contains(patch, value) {
		t.Fatalf("credential value %s leaked into the model patch", value)
	}
	for _, kv := range os.Environ() {
		if strings.Contains(kv, value) {
			t.Fatalf("credential value %s leaked into the parent environment", value)
		}
	}
	if strings.Contains(patch, "headers:") {
		t.Fatalf("Gateway provider must not project upstream headers:\n%s", patch)
	}
	if code := execDSHPlan(plan); code != 0 {
		t.Fatalf("execDSHPlan exit = %d, want 0", code)
	}
	out := readTextIfExists(outFile)
	if !strings.Contains(out, value) {
		t.Fatalf("child env should carry the Gateway credential")
	}
}

func TestFDSHWebGatewayTokenEnvPlan(t *testing.T) {
	home := t.TempDir()
	fdshLauncherTestEnv(t, home)
	dshBin, _ := writeFakeDSH(t, "@deepseek-ai/dsh@0.1.0-rc.6")
	t.Setenv("FORGE_DSH_BIN", dshBin)

	old := dshCredentialResolver
	dshCredentialResolver = func(providerID string) (dsh.TypedCredential, bool) {
		if providerID == dsh.GatewayProviderID {
			return dsh.TypedCredential{Token: "local-gateway-web"}, true
		}
		return dsh.TypedCredential{}, false
	}
	t.Cleanup(func() { dshCredentialResolver = old })

	plan, err := buildDSHPlan(nil)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Mode != "web" {
		t.Fatalf("mode = %q want web", plan.Mode)
	}
	keys := map[string]bool{}
	for _, kv := range plan.Env {
		k, _, _ := strings.Cut(kv, "=")
		keys[k] = true
	}
	if !keys[dsh.GatewayAPIKeyEnv] {
		t.Fatalf("web plan env missing %s (got %v)", dsh.GatewayAPIKeyEnv, plan.Env)
	}
	patch := readTextIfExists(plan.PatchPath)
	if strings.Contains(patch, "local-gateway-web") || strings.Contains(patch, "headers:") {
		t.Fatalf("plan/patch must stay secret-free:\n%s", patch)
	}
	if !strings.Contains(patch, "      wrenyard:") {
		t.Fatalf("Wrenyard Gateway route must stay visible:\n%s", patch)
	}
}

func TestFDSHScrubsInheritedCredentialEnv(t *testing.T) {
	home := t.TempDir()
	fdshLauncherTestEnv(t, home)
	dshBin, outFile := writeFakeDSH(t, "@deepseek-ai/dsh@0.1.0-rc.6")
	t.Setenv("FORGE_DSH_BIN", dshBin)
	t.Setenv("FORGE_DSH_STALE_KEY", "stale-secret-value")

	plan, err := buildDSHPlan(nil)
	if err != nil {
		t.Fatal(err)
	}
	if code := execDSHPlan(plan); code != 0 {
		t.Fatalf("execDSHPlan exit = %d, want 0", code)
	}
	out := readTextIfExists(outFile)
	if strings.Contains(out, "FORGE_DSH_STALE_KEY") || strings.Contains(out, "stale-secret-value") {
		t.Fatalf("inherited FORGE_DSH_* credential vars must be scrubbed from the child env:\n%s", out)
	}

	scrubbed := scrubInheritedFDSHEnv([]string{"PATH=/bin", "FORGE_DSH_SECRET=1", "FORGE_FDSH_MARKER=1", "HOME=/x"})
	for _, kv := range scrubbed {
		if strings.HasPrefix(kv, "FORGE_DSH_") || kv == "FORGE_FDSH_MARKER=1" {
			t.Fatalf("scrub should drop %q, got %v", kv, scrubbed)
		}
	}
	if !equalStrings(scrubbed, []string{"PATH=/bin", "HOME=/x"}) {
		t.Fatalf("scrubbed env = %v, want [PATH=/bin HOME=/x]", scrubbed)
	}
}

func TestFDSHRejectsUnsupportedProtocolVersion(t *testing.T) {
	home := t.TempDir()
	fdshLauncherTestEnv(t, home)
	dshBin, _ := writeFakeDSH(t, "@deepseek-ai/dsh@0.1.0-rc.5")
	t.Setenv("FORGE_DSH_BIN", dshBin)

	_, err := buildDSHPlan(nil)
	if err == nil {
		t.Fatal("buildDSHPlan should reject an unsupported dsh protocol")
	}
	if !strings.Contains(err.Error(), "0.1.0-rc.6") {
		t.Fatalf("error should name the supported protocol, got: %v", err)
	}
}

func TestFDSHNeverCreatesDSHProfile(t *testing.T) {
	home := t.TempDir()
	fdshLauncherTestEnv(t, home)
	dshBin, _ := writeFakeDSH(t, "@deepseek-ai/dsh@0.1.0-rc.6")
	t.Setenv("FORGE_DSH_BIN", dshBin)

	plan, err := buildDSHPlan(nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(plan.DSHHome, "profiles") {
		t.Fatalf("dsh home should not sit inside a profile dir, got %q", plan.DSHHome)
	}
	if exists(filepath.Join(plan.DSHHome, "profiles")) {
		t.Fatalf("fdsh must never create a DSH Profile, found %s", filepath.Join(plan.DSHHome, "profiles"))
	}
	entries, err := os.ReadDir(plan.DSHHome)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != filepath.Base(plan.PatchPath) {
		t.Fatalf("dsh home should contain only the model patch, got %v", entries)
	}
}
