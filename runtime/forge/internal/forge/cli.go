package forge

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/bashgate"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/driver"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/execution"
)

// RunBashGateIfNeeded handles the per-run native-client PreToolUse subprocess
// before stable-launcher dispatch or public CLI parsing.
func RunBashGateIfNeeded() (int, bool) {
	if !bashgate.Requested() {
		return 0, false
	}
	return bashgate.Run(os.Stdin, os.Stdout, os.Getenv(bashgate.ModeEnv), os.Getenv(bashgate.PolicyEnv)), true
}

// RunCodexMCPIfNeeded owns the hidden, per-run stdio server used only by
// restricted Codex plans. It is intentionally intercepted before public CLI
// parsing and stable-launcher dispatch so it cannot become another runtime
// orchestration surface.
func RunCodexMCPIfNeeded(args []string) (int, bool) {
	if len(args) == 0 || args[0] != driver.CodexMCPSubcommand {
		return 0, false
	}
	if len(args) != 3 || args[1] != "--policy" || strings.TrimSpace(args[2]) == "" {
		fmt.Fprintln(os.Stderr, "forge: invalid internal Codex MCP invocation")
		return 2, true
	}
	return execution.RunCodexMCPServer(context.Background(), os.Stdin, os.Stdout, os.Stderr, args[2]), true
}

func Run(args []string, prog string) int {
	if prog == "" {
		prog = "forge"
	}
	if len(args) == 0 {
		printHelp(prog)
		return 1
	}
	if args[0] == "--help" || args[0] == "-h" || args[0] == "help" {
		printHelp(prog)
		return 0
	}
	if args[0] == "--version" || args[0] == "version" {
		fmt.Printf("Forge %s\n", version)
		return 0
	}

	if strings.HasPrefix(args[0], "-") {
		return commandRun(args)
	}
	command, ok, ambiguous := resolveTopLevelCommand(args[0])
	if ambiguous {
		fmt.Fprintf(os.Stderr, "forge: ambiguous command %s\n", args[0])
		return 2
	}
	if !ok {
		fmt.Fprintf(os.Stderr, "forge: unknown command %q\n", args[0])
		return 2
	}

	switch command {
	case "profiles":
		return profilesCommand(args[1:])
	case "providers":
		return providersCommand(args[1:])
	case "auth":
		return authCommand(args[1:])
	case "shell":
		return shellCommand(args[1:])
	case "doctor":
		return doctorCommand(args[1:])
	case "setup":
		return setupCommand(args[1:])
	case "app":
		return claudeAppCommand(args[1:])
	case "update":
		return updateCommand(args[1:])
	case "statusline":
		return statuslineCommand(args[1:])
	case "quota":
		return quotaCommand(args[1:])
	case "llm":
		return llmCommand(args[1:])
	}
	fmt.Fprintf(os.Stderr, "forge: unknown command %q\n", args[0])
	return 2
}

var topLevelCommands = []string{
	"profiles",
	"providers",
	"auth",
	"shell",
	"doctor",
	"setup",
	"app",
	"update",
	"statusline",
	"quota",
	"llm",
}

func resolveTopLevelCommand(input string) (string, bool, bool) {
	var matches []string
	for _, command := range topLevelCommands {
		if input == command {
			return command, true, false
		}
		if strings.HasPrefix(command, input) {
			matches = append(matches, command)
		}
	}
	if len(matches) == 1 {
		return matches[0], true, false
	}
	if len(matches) > 1 {
		return "", false, true
	}
	return "", false, false
}

func printHelp(prog string) {
	fmt.Fprintf(os.Stdout, `Forge workflow CLI

FLAGS
  --version                Show forge version
  --help, -h               Show this help

DIRECT RUNTIME
  forge -p <profile> --permission <mode> -C <abs-dir> [--cap <name>] [-f text|json|stream-json] [-r <native_session_id>] <prompt>
                           Run one synchronous agent turn without Forge-managed session state

COMMANDS
  profiles list            List effective profiles and profile policies
  profiles list profile    List only effective active profiles
  profiles list policy     List only profile policies with candidate/effective resolution info
  profiles show <name>     Show profile availability details

  providers list           List canonical built-in providers with binding/auth state
  providers describe [--json]   Describe provider native raw LLM protocol support
  providers auth login <name>   Store credentials for a provider
  providers auth logout <name>  Remove credentials for a provider

  auth login <name>             Store a Forge-managed API key
  auth set <name> --key-stdin   Store an API key non-interactively
  auth list                     List configured credentials
  auth logout <name>            Remove a configured credential

  quota [name] [--json] [--refresh]
                           Report quota for a canonical provider/pool; with no name report all canonical pools

  llm <text|request_body> [-m <provider/model>] [--protocol <openai|anthropic>]
      [--timeout-ms <ms>] [--max-retries <count>] [--retry-backoff-ms <ms>]
      [--stdin]
                           Call a model directly; text, raw JSON request body, or stdin (--stdin) for
                           large/raw request bodies. Requires -m <provider/model> or config llm_model.

  app use <profile> [--port N] [--json]
                           Start Claude Code app with a profile (default port: 18080)

  statusline [--claude-code|--opencode]
                           Render statusline from stdin JSON

  doctor [target]          Run Forge health checks
    --json                 Output JSON
    target: codex

  setup                    Refresh shell aliases and run doctor

  update                   Update Forge, run setup, refresh shell aliases, and run doctor

NOTE
  CodeBuddy native is accessed through normal Forge profiles (forge profiles list),
  not through forge llm. forge llm always requires an explicit provider/model via
  -m <provider/model> or config llm_model.

SHELL (INTERNAL)
  shell dsh plan                Print the resolved fdsh/DSH launch plan
  shell dsh exec [fdsh args...] Launch the real dsh dialect through the fdsh launcher
`)
}
