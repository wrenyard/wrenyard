package grok

import (
	"io"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/bashgate"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

const (
	BashGuardModeEnv  = bashgate.ModeEnv
	BashGuardAllowEnv = bashgate.PolicyEnv
)

// BashGateHookBytes is the Grok materialization adapter for the neutral
// BashGate runtime. goos remains part of the adapter boundary because installed
// contract tests exercise both platform plans; Grok 0.2.106 itself uses the
// executable path unchanged on every platform.
func BashGateHookBytes(executable string, allow []catalog.BashRule, sensitiveEnvKeys []string, sensitivePaths []bashgate.SensitivePath, goos string) ([]byte, error) {
	return bashgate.GrokHookBytesForPlatform(executable, allow, sensitiveEnvKeys, sensitivePaths, goos)
}

func BashGateHookBytesForMode(executable string, allow []catalog.BashRule, sensitiveEnvKeys []string, sensitivePaths []bashgate.SensitivePath, goos string, bashUnrestricted bool) ([]byte, error) {
	return bashgate.GrokHookBytesForPlatformAndMode(executable, allow, sensitiveEnvKeys, sensitivePaths, goos, bashUnrestricted)
}

// BashGuardHookBytes is retained as a test/compatibility adapter; production
// materialization uses BashGateHookBytes so sensitive inputs are included.
func BashGuardHookBytes(executable string, allow []catalog.BashRule, goos string) ([]byte, error) {
	return BashGateHookBytes(executable, allow, nil, nil, goos)
}

// RunBashGuard delegates legacy Grok adapter tests to the neutral owner.
func RunBashGuard(input io.Reader, output io.Writer, encodedPolicy string) int {
	return bashgate.Run(input, output, string(bashgate.ClientGrok), encodedPolicy)
}
