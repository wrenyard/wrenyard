package shell

import (
	"strings"
)

// grokFunctionName is the single shell-Grok entry point. It is intentionally
// distinct from the official `grok` binary so it never shadows it, and it is
// not per-provider: model selection stays inside the Grok /model selector.
const grokFunctionName = "fgrok"

// RenderGrokZsh returns the zsh definition of the `fgrok` function. It always
// invokes `forge shell grok exec --` and forwards all arguments.
func RenderGrokZsh() string {
	var b strings.Builder
	b.WriteString("# Forge shell-Grok entry point (single wrapper, not per-provider).\n")
	b.WriteString(grokFunctionName)
	b.WriteString("() {\n")
	b.WriteString("  command forge shell grok exec -- \"$@\"\n")
	b.WriteString("}\n")
	return b.String()
}

// RenderGrokPowerShell returns the PowerShell definition of the `fgrok`
// function, mirroring the zsh entry point. forgeBin is the resolved forge
// binary path used in the invocation.
func RenderGrokPowerShell(forgeBin string) string {
	var b strings.Builder
	b.WriteString("# Forge shell-Grok entry point (single wrapper, not per-provider).\n")
	b.WriteString("function ")
	b.WriteString(grokFunctionName)
	b.WriteString(" {\n")
	b.WriteString("    & ")
	b.WriteString(powerShellQuote(forgeBin))
	b.WriteString(" 'shell' 'grok' 'exec' '--' @args\n")
	b.WriteString("}\n")
	return b.String()
}
