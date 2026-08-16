package shell

import (
	"strings"
)

// grokFunctionName is the single shell-Grok entry point. It is intentionally
// distinct from the official `grok` binary so it never shadows it, and it is
// not per-provider: model selection stays inside the Grok /model selector.
const grokFunctionName = "fgrok"

// RenderGrokZsh returns the zsh definition of the `fgrok` function. It always
// invokes `wrenyard runtime shell grok exec --` and forwards all arguments.
func RenderGrokZsh() string {
	var b strings.Builder
	b.WriteString("# Wrenyard shell-Grok entry point (single wrapper, not per-provider).\n")
	b.WriteString(grokFunctionName)
	b.WriteString("() {\n")
	b.WriteString("  command wrenyard runtime shell grok exec -- \"$@\"\n")
	b.WriteString("}\n")
	return b.String()
}

// RenderGrokPowerShell returns the PowerShell definition of the `fgrok`
// function, mirroring the zsh entry point. launcher is the public Wrenyard
// launcher name used in the invocation.
func RenderGrokPowerShell(launcher string) string {
	var b strings.Builder
	b.WriteString("# Wrenyard shell-Grok entry point (single wrapper, not per-provider).\n")
	b.WriteString("function ")
	b.WriteString(grokFunctionName)
	b.WriteString(" {\n")
	b.WriteString("    & ")
	b.WriteString(powerShellQuote(launcher))
	b.WriteString(" 'runtime' 'shell' 'grok' 'exec' '--' @args\n")
	b.WriteString("}\n")
	return b.String()
}
