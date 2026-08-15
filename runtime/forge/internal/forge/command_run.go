package forge

import (
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/driver"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/execution"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/protocol"
)

// commandRun is the thin root CLI facade for the synchronous direct runtime.
// It performs flag parsing and prompt stitching only, then delegates the full
// execution boundary (gate, plan, process, output) to execution.Run. It holds
// no process/plan/event/output business logic.
func commandRun(args []string) int {
	req, profileID, err := parseCommandRunArgs(args)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	if profileID != "" {
		req.ProfileName = profileID
	}
	_, code := execution.Run(req, executionDependencies(), os.Stdout, os.Stderr)
	return code
}

// parseCommandRunArgs converts raw CLI args into an execution.Request. It
// preserves the exact public flag surface, default profile resolution,
// format validation, removed -m/--mcp and -- separator errors, stdin detection
// and prompt stitching. Permission is carried through as a catalog.PermissionMode
// unvalidated (the execution boundary parses it).
func parseCommandRunArgs(args []string) (execution.Request, string, error) {
	if hasRemovedMCPFlag(args) {
		return execution.Request{}, "", fmt.Errorf("forge: -m/--mcp has been removed from direct runtime; use OpenCode plugins, Claude Code command-line dispatch, or direct client configuration instead")
	}
	if hasPromptSeparator(args) {
		return execution.Request{}, "", fmt.Errorf("forge: direct runtime does not support -- before the prompt; pass prompt words directly or via stdin")
	}
	fs := flag.NewFlagSet("forge", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var req execution.Request
	var profileName string
	var profilePolicy string
	fs.StringVar(&profileName, "p", "", "")
	fs.StringVar(&profileName, "profile", "", "")
	fs.StringVar(&profilePolicy, "profile-policy", "", "")
	format := string(protocol.OutputFormatText)
	fs.StringVar(&format, "f", string(protocol.OutputFormatText), "")
	fs.StringVar(&format, "format", string(protocol.OutputFormatText), "")
	var perm string
	fs.StringVar(&perm, "permission", "", "")
	fs.StringVar(&req.WorkDir, "C", "", "")
	fs.StringVar(&req.WorkDir, "cwd", "", "")
	fs.StringVar(&req.ResumeID, "r", "", "")
	fs.StringVar(&req.ResumeID, "resume", "", "")
	var capabilities stringSliceFlag
	fs.Var(&capabilities, "cap", "")
	fs.Var(&capabilities, "capability", "")
	if err := fs.Parse(args); err != nil {
		return execution.Request{}, "", err
	}
	req.Format = protocol.OutputFormat(format)
	req.Capabilities = append([]string(nil), capabilities...)

	// Parse per-run HTTP MCP headers from env; reject structural issues
	// (malformed JSON, empty names, CR/LF) before dispatch.
	if raw := os.Getenv(driver.MCPHTTPHeadersEnvVar); raw != "" {
		parsed, err := driver.ParseMCPHTTPHeaders(raw, nil)
		if err != nil {
			return execution.Request{}, "", err
		}
		req.MCPHTTPHeaders = parsed
	}

	switch req.Format {
	case "", protocol.OutputFormatText:
		req.Format = protocol.OutputFormatText
	case protocol.OutputFormatJSON, protocol.OutputFormatStreamJSON:
	default:
		return execution.Request{}, "", fmt.Errorf("forge: unsupported --format %q", req.Format)
	}

	// Enforce exactly one selector: --profile or --profile-policy.
	profileName = strings.TrimSpace(profileName)
	profilePolicy = strings.TrimSpace(profilePolicy)
	if profileName == "" && profilePolicy == "" {
		return execution.Request{}, "", fmt.Errorf("forge: profile is required via -p/--profile or --profile-policy")
	}
	if profileName != "" && profilePolicy != "" {
		return execution.Request{}, "", fmt.Errorf("forge: specify exactly one of -p/--profile or --profile-policy, not both")
	}

	prompt := strings.TrimSpace(strings.Join(fs.Args(), " "))
	stdinText, err := readPipedStdin()
	if err != nil {
		return execution.Request{}, "", err
	}
	req.Prompt = combinePrompt(prompt, stdinText)
	if strings.TrimSpace(req.Prompt) == "" {
		return execution.Request{}, "", fmt.Errorf("forge: prompt is required via argv or stdin")
	}
	req.Permission = catalog.PermissionMode(strings.TrimSpace(perm))
	req.Clean = true

	// Resolve policy if --profile-policy was used.
	resolvedProfile := profileName
	if resolvedProfile == "" && profilePolicy != "" {
		candidates, err := resolveProfilePolicyCandidates(profilePolicy)
		if err != nil {
			return execution.Request{}, "", err
		}
		if len(candidates) == 0 {
			return execution.Request{}, "", fmt.Errorf("no available profile in policy %q", profilePolicy)
		}
		req.PolicyName = profilePolicy
		req.PolicyCandidates = candidates
	}
	if profileName != "" {
		req.ProfileName = profileName
		req.Selector = "profile"
	} else {
		req.Selector = "policy"
	}

	return req, resolvedProfile, nil
}

func hasRemovedMCPFlag(args []string) bool {
	for _, arg := range args {
		if arg == "-m" || arg == "--mcp" || strings.HasPrefix(arg, "--mcp=") {
			return true
		}
	}
	return false
}

func hasPromptSeparator(args []string) bool {
	expectValue := false
	for _, arg := range args {
		if expectValue {
			expectValue = false
			continue
		}
		if arg == "--" {
			return true
		}
		if arg == "-" {
			return false
		}
		if strings.HasPrefix(arg, "--") {
			if strings.Contains(arg, "=") {
				continue
			}
			switch arg {
			case "--profile", "--format", "--permission", "--cwd", "--resume", "--cap", "--capability":
				expectValue = true
			}
			continue
		}
		if strings.HasPrefix(arg, "-") {
			switch arg {
			case "-p", "-f", "-C", "-r":
				expectValue = true
			}
			continue
		}
		return false
	}
	return false
}

func readPipedStdin() (string, error) {
	info, err := os.Stdin.Stat()
	if err != nil {
		return "", err
	}
	if info.Mode()&os.ModeCharDevice != 0 {
		return "", nil
	}
	data, err := io.ReadAll(os.Stdin)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func combinePrompt(argvPrompt, stdinText string) string {
	argvPrompt = strings.TrimSpace(argvPrompt)
	stdinText = strings.TrimSpace(stdinText)
	if argvPrompt == "" {
		return stdinText
	}
	if stdinText == "" {
		return argvPrompt
	}
	return argvPrompt + "\n\nPiped context:\n" + stdinText
}
