package forge

import (
	"strings"
	"testing"
)

func TestRunAgentCommandIsRemoved(t *testing.T) {
	stderr := captureStderr(t, func() {
		if code := Run([]string{"agent"}, "forge"); code != 2 {
			t.Fatalf("expected exit code 2 for removed agent command, got %d", code)
		}
	})
	if !strings.Contains(stderr, `unknown command "agent"`) {
		t.Fatalf("expected removed agent command to be unknown, got stderr: %s", stderr)
	}
	if strings.Contains(stderr, "deprecated") || strings.Contains(stderr, "--ignore-"+"deprecated") {
		t.Fatalf("removed agent command must not expose legacy opt-in guidance, got stderr: %s", stderr)
	}
}

func TestRunAgentIgnoreDeprecatedIsNotRecognized(t *testing.T) {
	optIn := "--ignore-" + "deprecated"
	stderr := captureStderr(t, func() {
		if code := Run([]string{"agent", optIn}, "forge"); code != 2 {
			t.Fatalf("expected exit code 2 for removed agent opt-in, got %d", code)
		}
	})
	if !strings.Contains(stderr, `unknown command "agent"`) {
		t.Fatalf("expected removed agent opt-in to be unknown, got stderr: %s", stderr)
	}
	if strings.Contains(stderr, "expected one of run") || strings.Contains(stderr, "deprecated") {
		t.Fatalf("removed agent opt-in must not reach a legacy parser, got stderr: %s", stderr)
	}
}

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
	if !strings.Contains(stdout, "[-r <native_session_id>]") {
		t.Fatalf("expected top-level help to show direct resume flag, got: %s", stdout)
	}
	if strings.Contains(stdout, "agent ...") || strings.Contains(stdout, "forge "+"agent") || strings.Contains(stdout, "--ignore-"+"deprecated") {
		t.Fatalf("top-level help should not mention removed agent command surface, got: %s", stdout)
	}
	if strings.Contains(stdout, "run                    Start a new task") || strings.Contains(stdout, "resume                 Resume a stopped session") || strings.Contains(stdout, "cancel                 Cancel a running session") {
		t.Fatalf("top-level help should not advertise legacy agent subcommands, got: %s", stdout)
	}
	if strings.Contains(stdout, "target: ccb") {
		t.Fatalf("top-level help should not mention removed ccb doctor target, got: %s", stdout)
	}
}

func TestRunForgeMCPCommandIsRemoved(t *testing.T) {
	stderr := captureStderr(t, func() {
		if code := Run([]string{"mcp"}, "forge"); code != 2 {
			t.Fatalf("expected exit code 2 for removed mcp command, got %d", code)
		}
	})
	if !strings.Contains(stderr, `unknown command "mcp"`) {
		t.Fatalf("expected removed MCP command to be unknown, got stderr: %s", stderr)
	}
}

func TestRunAmbiguousCommandPrefixErrors(t *testing.T) {
	stderr := captureStderr(t, func() {
		if code := Run([]string{"p"}, "forge"); code != 2 {
			t.Fatalf("expected exit code 2 for ambiguous prefix, got %d", code)
		}
	})
	if !strings.Contains(stderr, "forge: ambiguous command p") {
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
