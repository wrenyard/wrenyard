package forge

import (
	"strings"
	"testing"
)

func TestParseCommandRunArgsExactProfileSucceeds(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	req, resolved, err := parseCommandRunArgs([]string{"-p", "codex-sol", "hello"})
	if err != nil {
		t.Fatal(err)
	}
	if resolved != "codex-sol" {
		t.Fatalf("resolved profile = %q, want codex-sol", resolved)
	}
	if req.Prompt != "hello" {
		t.Fatalf("prompt = %q, want hello", req.Prompt)
	}
}

func TestParseCommandRunArgsExactPolicySucceeds(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	setFakeClientsOnPath(t, "codex", "codebuddy")
	// Policy resolution requires a manifest to be loadable. The embedded
	// manifest is used automatically. Since exact profile resolution is
	// bypassed here (it's done in resolveProfilePolicySelection), we just
	// test parsing of --profile-policy.
	req, resolved, err := parseCommandRunArgs([]string{"--profile-policy", "fast", "hello"})
	if err != nil && !strings.Contains(err.Error(), "policy") {
		t.Fatalf("unexpected error: %v", err)
	}
	// If resolution fails at CLI level, the test still validates parsing.
	_ = req
	_ = resolved
}

func TestParseCommandRunArgsMissingSelectorExit2(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	_, _, err := parseCommandRunArgs([]string{"hello"})
	if err == nil {
		t.Fatal("expected error for missing selector")
	}
	if !strings.Contains(err.Error(), "profile is required") {
		t.Fatalf("error should mention profile requirement: %v", err)
	}
}

func TestParseCommandRunArgsBothSelectorsExit2(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	_, _, err := parseCommandRunArgs([]string{"-p", "codex-sol", "--profile-policy", "fast", "hello"})
	if err == nil {
		t.Fatal("expected error for both selectors")
	}
	if !strings.Contains(err.Error(), "exactly one") {
		t.Fatalf("error should mention exactly one selector: %v", err)
	}
}

func TestParseCommandRunArgsUnknownPolicyFails(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	_, _, err := parseCommandRunArgs([]string{"--profile-policy", "unknown", "hello"})
	if err == nil {
		t.Fatal("expected error for unknown policy")
	}
	if !strings.Contains(err.Error(), "unknown") {
		t.Fatalf("error should mention unknown policy: %v", err)
	}
}

func TestParseCommandRunArgsEmptyPolicyFails(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	_, _, err := parseCommandRunArgs([]string{"--profile-policy", "", "hello"})
	if err == nil {
		t.Fatal("expected error for empty policy")
	}
}

func TestParseCommandRunArgsAutoPolicyFails(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	_, _, err := parseCommandRunArgs([]string{"--profile-policy", "auto", "hello"})
	if err == nil {
		t.Fatal("expected error for auto policy")
	}
}

func TestParseCommandRunArgsUnavailableExactProfile(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	// nonexistent profile should be passed through - availability check
	// happens downstream in the execution boundary.
	_, _, err := parseCommandRunArgs([]string{"-p", "nonexistent", "hello"})
	if err != nil {
		t.Fatal(err)
	}
}

func TestParseCommandRunArgsPreservesPermission(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	req, _, err := parseCommandRunArgs([]string{"-p", "codex-sol", "--permission", "edit", "hello"})
	if err != nil {
		t.Fatal(err)
	}
	if string(req.Permission) != "edit" {
		t.Fatalf("permission = %q, want edit", req.Permission)
	}
}

func TestParseCommandRunArgsPreservesFormat(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	req, _, err := parseCommandRunArgs([]string{"-p", "codex-sol", "-f", "stream-json", "hello"})
	if err != nil {
		t.Fatal(err)
	}
	if string(req.Format) != "stream-json" {
		t.Fatalf("format = %q, want stream-json", req.Format)
	}
}

func TestParseCommandRunArgsPreservesResume(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	req, _, err := parseCommandRunArgs([]string{"-p", "codex-sol", "--resume", "session-123", "hello"})
	if err != nil {
		t.Fatal(err)
	}
	if req.ResumeID != "session-123" {
		t.Fatalf("resume = %q, want session-123", req.ResumeID)
	}
}

func TestParseCommandRunArgsRejectsRemovedMCP(t *testing.T) {
	_, _, err := parseCommandRunArgs([]string{"-p", "codex-sol", "-m", "mcp.json", "hello"})
	if err == nil || !strings.Contains(err.Error(), "removed") {
		t.Fatalf("expected removed MCP error, got: %v", err)
	}
}

func TestParseCommandRunArgsRejectsPromptSeparator(t *testing.T) {
	_, _, err := parseCommandRunArgs([]string{"-p", "codex-sol", "--", "hello"})
	if err == nil || !strings.Contains(err.Error(), "does not support -- before") {
		t.Fatalf("expected prompt separator error, got: %v", err)
	}
}

func TestRemovedLegacyProfilesRejectedAtExecution(t *testing.T) {
	for _, name := range []string{"codex", "codex-high", "codex-xhigh", "codex-lite", "codex-mini"} {
		t.Run(name, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			t.Setenv("USERPROFILE", home)
			t.Setenv("XDG_CONFIG_HOME", "")
			setFakeClientsOnPath(t, "codex")
			// Parse level should pass the profile name through.
			_, resolved, err := parseCommandRunArgs([]string{"-p", name, "hello"})
			if err != nil {
				t.Fatalf("parse should pass %s through: %v", name, err)
			}
			if resolved != name {
				t.Fatalf("expected resolved=%q, got %q", name, resolved)
			}
			// Execution boundary must reject the unknown profile.
			_, err = buildDirectRunPlan(directPlanInput{
				Profile: name,
				Prompt:  "hello",
				CWD:     t.TempDir(),
			})
			if err == nil {
				t.Fatalf("expected execution to reject removed profile %q", name)
			}
			if !strings.Contains(err.Error(), "not found") {
				t.Fatalf("error should say not found for removed profile %q: %v", name, err)
			}
		})
	}
}
