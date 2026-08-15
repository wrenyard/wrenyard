package execution

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/profile"
)

// fakeDeps is a configurable Dependencies used across Prepare/gate tests. Each
// callback defaults to a "permissive" behavior; individual tests override the
// fields they need to exercise. Only LoadProfile/ClientEnabled/ResolveProfile
// are exercised on the gate path before driver side effects.
type fakeDeps struct {
	Dependencies
	loadProfile    func(name string) (ProfileDefinition, bool, error)
	clientEnabled  func(client string) bool
	resolveProfile func(def ProfileDefinition) (profile.ResolvedProfile, error)
	callOrder      []string
}

func newFakeDeps(t *testing.T) *fakeDeps {
	t.Helper()
	d := &fakeDeps{
		loadProfile: func(name string) (ProfileDefinition, bool, error) {
			return ProfileDefinition{Name: name, Client: "opencode"}, true, nil
		},
		clientEnabled: func(client string) bool {
			return true
		},
		resolveProfile: func(def ProfileDefinition) (profile.ResolvedProfile, error) {
			return profile.ResolvedProfile{
				Name:          def.Name,
				Client:        catalog.Client{},
				Provider:      catalog.Provider{},
				Compatibility: profile.CompatibilityClientUnregistered,
				Credential:    profile.CredentialPlan{TargetEnv: "ANTHROPIC_AUTH_TOKEN"},
			}, nil
		},
	}
	d.Dependencies = Dependencies{
		LoadProfile: func(name string) (ProfileDefinition, bool, error) {
			d.callOrder = append(d.callOrder, "LoadProfile")
			return d.loadProfile(name)
		},
		ClientEnabled: func(client string) bool {
			d.callOrder = append(d.callOrder, "ClientEnabled")
			return d.clientEnabled(client)
		},
		ResolveProfile: func(def ProfileDefinition) (profile.ResolvedProfile, error) {
			d.callOrder = append(d.callOrder, "ResolveProfile")
			return d.resolveProfile(def)
		},
		DataDir: t.TempDir(),
	}
	return d
}

func prepareReq(name, prompt, cwd, perm string) Request {
	return Request{
		ProfileName: name,
		Prompt:      prompt,
		WorkDir:     cwd,
		Permission:  catalog.PermissionMode(perm),
	}
}

func tempDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	// Create so resolveWorkDir's stat/cwd/MCP gate passes deterministically.
	if err := os.MkdirAll(filepath.Join(dir, "work"), 0o755); err != nil {
		t.Fatalf("setup work dir: %v", err)
	}
	return filepath.Join(dir, "work")
}

func TestPrepare_ProfileNotFound(t *testing.T) {
	d := newFakeDeps(t)
	d.loadProfile = func(name string) (ProfileDefinition, bool, error) {
		return ProfileDefinition{}, false, nil
	}
	_, _, err := Prepare(prepareReq("ghost", "hi", tempDir(t), ""), d.Dependencies)
	if err == nil {
		t.Fatal("expected error for missing profile")
	}
	if err.Error() != `profile "ghost" not found` {
		t.Fatalf("got %q, want exact 'profile \"ghost\" not found'", err.Error())
	}
}

func TestPrepare_ClientDisabled(t *testing.T) {
	d := newFakeDeps(t)
	d.loadProfile = func(name string) (ProfileDefinition, bool, error) {
		return ProfileDefinition{Name: name, Client: "opencode"}, true, nil
	}
	d.clientEnabled = func(client string) bool { return false }
	_, _, err := Prepare(prepareReq("p", "hi", tempDir(t), ""), d.Dependencies)
	if err == nil {
		t.Fatal("expected client disabled error")
	}
	if err.Error() != `client "opencode" disabled in config` {
		t.Fatalf("got %q, want exact 'client \"opencode\" disabled in config'", err.Error())
	}
}

func TestPrepare_InvalidPermissionAfterGatesBeforeResolve(t *testing.T) {
	d := newFakeDeps(t)
	got := tempDir(t)
	_, _, err := Prepare(prepareReq("p", "hi", got, "bogus"), d.Dependencies)
	if err == nil {
		t.Fatal("expected unsupported permission error")
	}
	if err.Error() != `unsupported permission mode "bogus"` {
		t.Fatalf("got %q", err.Error())
	}
	// LoadProfile, ClientEnabled, workdir/MCP must
	// have run, but ResolveProfile must NOT run because permission parse fails
	// before it.
	for _, step := range d.callOrder {
		if step == "ResolveProfile" {
			t.Fatalf("ResolveProfile must not run before permission gate; order=%v", d.callOrder)
		}
	}
	// Permission parsing happens after access/client/MCP gates. Confirm the
	// gates were exercised.
	if len(d.callOrder) == 0 || d.callOrder[0] != "LoadProfile" {
		t.Fatalf("expected gate steps before permission error; order=%v", d.callOrder)
	}
}

func TestPrepare_ResolveProfileCredentialErrorBeforeDriverSideEffects(t *testing.T) {
	d := newFakeDeps(t)
	d.resolveProfile = func(def ProfileDefinition) (profile.ResolvedProfile, error) {
		return profile.ResolvedProfile{}, errors.New("credential boom")
	}
	_, _, err := Prepare(prepareReq("p", "hi", tempDir(t), ""), d.Dependencies)
	if err == nil {
		t.Fatal("expected resolve profile error")
	}
	if err.Error() != "credential boom" {
		t.Fatalf("got %q", err.Error())
	}
	// The error must occur at ResolveProfile, before BuildPlan driver side
	// effects. Last recorded step is ResolveProfile.
	if len(d.callOrder) == 0 || d.callOrder[len(d.callOrder)-1] != "ResolveProfile" {
		t.Fatalf("expected ResolveProfile last; order=%v", d.callOrder)
	}
}

func TestPrepare_OpenCodeDeterministic(t *testing.T) {
	dir := t.TempDir()
	d := newFakeDeps(t)
	d.loadProfile = func(name string) (ProfileDefinition, bool, error) {
		return ProfileDefinition{
			Name:     name,
			Client:   "opencode",
			Env:      map[string]string{"OPENCODE_MODEL": "sonnet"},
			Launcher: map[string]interface{}{"command": "opencode", "default_args": []interface{}{"--foo"}},
		}, true, nil
	}
	d.Dependencies.DataDir = dir

	plan, family, err := Prepare(prepareReq("oc", "do it", tempDir(t), ""), d.Dependencies)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if family != "opencode" {
		t.Fatalf("family=%q want opencode", family)
	}
	if plan.Dialect != catalog.DialectOpenCode {
		t.Fatalf("dialect=%q want opencode", plan.Dialect)
	}
	if plan.ProfileName != "oc" {
		t.Fatalf("profile=%q want oc", plan.ProfileName)
	}
	// Restricted OpenCode must load its isolated BashGate plugin, so --pure is
	// reserved for the yolo path that has no guard.
	want := []string{"opencode", "run", "--foo", "-m", "sonnet", "--format", "json", "do it"}
	if len(plan.Command) != len(want) {
		t.Fatalf("command=%v want %v", plan.Command, want)
	}
	for i := range want {
		if plan.Command[i] != want[i] {
			t.Fatalf("command=%v want %v", plan.Command, want)
		}
	}
	if plan.Env["FORGE_PROFILE"] != "oc" {
		t.Fatalf("env FORGE_PROFILE=%q want oc", plan.Env["FORGE_PROFILE"])
	}
	if plan.Env["OPENCODE_MODEL"] != "sonnet" {
		t.Fatalf("env OPENCODE_MODEL=%q want sonnet", plan.Env["OPENCODE_MODEL"])
	}
	if plan.Env["ANTHROPIC_AUTH_TOKEN"] != "" {
		t.Fatalf("credential should not be injected for empty value, got %q", plan.Env["ANTHROPIC_AUTH_TOKEN"])
	}
}

func TestPrepare_CodexDeterministic(t *testing.T) {
	d := newFakeDeps(t)
	d.loadProfile = func(name string) (ProfileDefinition, bool, error) {
		return ProfileDefinition{
			Name:   name,
			Client: "codex",
			Env:    map[string]string{"CODEX_MODEL": "gpt-5"},
		}, true, nil
	}
	plan, family, err := Prepare(prepareReq("cx", "do it", tempDir(t), ""), d.Dependencies)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if family != "codex" {
		t.Fatalf("family=%q want codex", family)
	}
	if plan.Dialect != catalog.DialectCodex {
		t.Fatalf("dialect=%q want codex", plan.Dialect)
	}
	if plan.ProfileName != "cx" {
		t.Fatalf("profile=%q want cx", plan.ProfileName)
	}
	// CodexAdapter always begins with codex --search exec ... deterministically.
	if len(plan.Command) == 0 || plan.Command[0] != "codex" {
		t.Fatalf("command[0]=%q want codex", firstOr(plan.Command))
	}
	if plan.Env["FORGE_PROFILE"] != "cx" {
		t.Fatalf("env FORGE_PROFILE=%q want cx", plan.Env["FORGE_PROFILE"])
	}
	if plan.Env["CODEX_MODEL"] != "gpt-5" {
		t.Fatalf("env CODEX_MODEL=%q want gpt-5", plan.Env["CODEX_MODEL"])
	}
}

func TestPrepare_ClaudeDeterministic(t *testing.T) {
	d := newFakeDeps(t)
	d.loadProfile = func(name string) (ProfileDefinition, bool, error) {
		return ProfileDefinition{
			Name:     name,
			Client:   "claude",
			Env:      map[string]string{},
			Launcher: map[string]interface{}{"command": "claude", "default_args": []interface{}{"--model", "opus"}},
		}, true, nil
	}
	plan, family, err := Prepare(prepareReq("cl", "do it", tempDir(t), ""), d.Dependencies)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if family != "claude" {
		t.Fatalf("family=%q want claude", family)
	}
	if plan.Dialect != catalog.DialectClaudeCode {
		t.Fatalf("dialect=%q want claude-code", plan.Dialect)
	}
	if plan.ProfileName != "cl" {
		t.Fatalf("profile=%q want cl", plan.ProfileName)
	}
	// Legacy claude path: launcher command "claude", default_args, then prompt
	// args (-p ...). The first token is the launcher command.
	if len(plan.Command) == 0 || plan.Command[0] != "claude" {
		t.Fatalf("command[0]=%q want claude", firstOr(plan.Command))
	}
	if plan.Env["FORGE_PROFILE"] != "cl" {
		t.Fatalf("env FORGE_PROFILE=%q want cl", plan.Env["FORGE_PROFILE"])
	}
}

func TestPrepare_DSHDeterministic(t *testing.T) {
	d := newFakeDeps(t)
	d.loadProfile = func(name string) (ProfileDefinition, bool, error) {
		return ProfileDefinition{
			Name:   name,
			Client: "dsh",
			Env:    map[string]string{catalog.EnvDSHModel: "llm-pi-ai.zhipu-coding/glm-5.3"},
		}, true, nil
	}
	plan, family, err := Prepare(prepareReq("ds", "do it", tempDir(t), ""), d.Dependencies)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if family != "dsh" {
		t.Fatalf("family=%q want dsh", family)
	}
	if plan.Dialect != catalog.DialectDSH {
		t.Fatalf("dialect=%q want dsh", plan.Dialect)
	}
	if plan.ProfileName != "ds" {
		t.Fatalf("profile=%q want ds", plan.ProfileName)
	}
	// DSH dispatches through the dedicated fdsh hidden-agent planner, never an
	// emulation path.
	wantCommand := []string{"fdsh", "--forge-agent", "--", "do it"}
	if len(plan.Command) != len(wantCommand) {
		t.Fatalf("command=%v want %v", plan.Command, wantCommand)
	}
	for i := range wantCommand {
		if plan.Command[i] != wantCommand[i] {
			t.Fatalf("command=%v want %v", plan.Command, wantCommand)
		}
	}
	if plan.TranscriptFamily != "dsh" {
		t.Fatalf("transcript family=%q want dsh", plan.TranscriptFamily)
	}
	if plan.Env[catalog.EnvDSHModel] != "llm-pi-ai.zhipu-coding/glm-5.3" {
		t.Fatalf("env DSH_MODEL=%q want llm-pi-ai.zhipu-coding/glm-5.3", plan.Env[catalog.EnvDSHModel])
	}
}

func firstOr(s []string) string {
	if len(s) == 0 {
		return ""
	}
	return s[0]
}
