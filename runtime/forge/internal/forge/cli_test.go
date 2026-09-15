package forge

import (
	"strings"
	"testing"
)

func TestRunHelpShowsDirectRuntime(t *testing.T) {
	var code int
	stdout := captureStdout(t, func() {
		code = Run([]string{"--help"}, "forge")
	})
	if code != 0 {
		t.Fatalf("expected forge --help to exit 0, got %d", code)
	}
	if !strings.Contains(stdout, "forge -p <profile> --permission <mode> -C <abs-dir>") {
		t.Fatalf("expected top-level help to show direct runtime usage, got: %s", stdout)
	}
	if !strings.Contains(stdout, "Forge runtime CLI") {
		t.Fatalf("expected current runtime CLI branding, got: %s", stdout)
	}
	if !strings.Contains(stdout, "[-r <native_session_id>]") {
		t.Fatalf("expected top-level help to show direct resume flag, got: %s", stdout)
	}
}

func TestRunAmbiguousCommandPrefixErrors(t *testing.T) {
	stderr := captureStderr(t, func() {
		if code := Run([]string{"s"}, "forge"); code != 2 {
			t.Fatalf("expected exit code 2 for ambiguous prefix, got %d", code)
		}
	})
	if !strings.Contains(stderr, "forge: ambiguous command s") {
		t.Fatalf("expected ambiguous command error, got stderr: %s", stderr)
	}
}

func TestDirectRunBuiltinCommandPrefixWinsOverPromptFallback(t *testing.T) {
	var code int
	stdout := captureStdout(t, func() {
		code = Run([]string{"doc"}, "forge")
	})
	if code != 0 && code != 1 {
		t.Fatalf("expected unique command prefix doc to route to doctor, got %d", code)
	}
	if !strings.Contains(stdout, "forge-config:") {
		t.Fatalf("expected doctor output for command prefix, got %q", stdout)
	}
}
