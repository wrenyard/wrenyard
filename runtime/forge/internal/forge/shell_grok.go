package forge

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/grok"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/driver"
)

// shellGrokCommand handles `forge shell grok <subcommand> ...`.
func shellGrokCommand(args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "forge shell grok: expected 'plan' or 'exec'")
		return 2
	}
	switch args[0] {
	case "plan":
		return grokPlanCommand()
	case "exec":
		// Expect: exec -- <grok args...>
		if len(args) < 2 || args[1] != "--" {
			fmt.Fprintln(os.Stderr, "forge shell grok exec: usage: forge shell grok exec -- <args...>")
			return 2
		}
		return grokExecCommand(args[2:])
	default:
		fmt.Fprintf(os.Stderr, "forge shell grok: unknown subcommand %q (expected 'plan' or 'exec')\n", args[0])
		return 2
	}
}

// grokPlanCommand prints expected paths, projected models, missing credentials
// and deterministic skip reasons without exposing any secret material. It does
// not materialize config or run grok.
func grokPlanCommand() int {
	reg, err := loadCatalogRegistry()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	plan := grok.BuildPlan(reg, ResolveCredential)

	fmt.Println("Forge shell-Grok plan")
	fmt.Printf("GROK_HOME: %s\n", plan.Paths.GrokHome)
	fmt.Printf("config:    %s\n", plan.Paths.ConfigPath)
	fmt.Printf("overlay:   %s (optional)\n", plan.Paths.OverlayPath)

	fmt.Printf("\nProjected models (%d):\n", len(plan.Projections))
	for _, p := range plan.Projections {
		fmt.Printf("  - id=%s\n", p.ID)
		fmt.Printf("      name=%s model=%s\n", p.Name, p.Model)
		fmt.Printf("      base_url=%s env_key=%s context_window=%d\n", p.BaseURL, p.EnvKey, p.ContextWindow)
	}

	if len(plan.MissingCredentials) > 0 {
		fmt.Printf("\nMissing credentials (run `forge providers auth login <provider>`):\n")
		for _, id := range plan.MissingCredentials {
			fmt.Printf("  - %s\n", id)
		}
	}

	fmt.Printf("\nSkip reasons (%d):\n", len(plan.Skips))
	for _, s := range plan.Skips {
		if s.ModelID == "" {
			fmt.Printf("  - provider %s: %s\n", s.ProviderID, s.Reason)
		} else {
			fmt.Printf("  - %s/%s: %s\n", s.ProviderID, s.ModelID, s.Reason)
		}
	}

	fmt.Printf("\nOverlay: ")
	if plan.OverlayValid == nil {
		fmt.Println("ok (absent or valid)")
	} else {
		fmt.Printf("INVALID: %v\n", plan.OverlayValid)
	}
	return 0
}

// projectedModelID resolves the [models] value for a managed key. It returns
// preferred when a projection carries that exact id, otherwise the first
// projection id, or "" when there are no projections at all.
func projectedModelID(projections []grok.Projection, preferred string) string {
	for _, p := range projections {
		if p.ID == preferred {
			return preferred
		}
	}
	if len(projections) > 0 {
		return projections[0].ID
	}
	return ""
}

// grokExecCommand materializes the Grok config, resolves Forge-managed
// credentials, injects only the deterministic FORGE_GROK_<PROVIDER>_API_KEY
// values into the child environment, and execs the official grok binary with
// argv fully passed through (plus a safe default permission flag when the user
// has not expressed a permission/approval/sandbox intent).
func grokExecCommand(grokArgs []string) int {
	paths := grok.ResolvePaths()
	reg, err := loadCatalogRegistry()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	projections, _ := grok.EligibleProjections(reg, ResolveCredential)

	if err := grok.Materialize(grok.MaterializeInput{
		ConfigPath:          paths.ConfigPath,
		OverlayPath:         paths.OverlayPath,
		Projections:         projections,
		DefaultModel:        projectedModelID(projections, grok.DefaultModelID),
		SessionSummaryModel: projectedModelID(projections, grok.DefaultSessionSummaryModel),
	}); err != nil {
		fmt.Fprintf(os.Stderr, "forge shell grok exec: materialize failed: %v\n", err)
		return 1
	}

	childEnv := map[string]string{"GROK_HOME": paths.GrokHome}
	for _, p := range projections {
		if cred, ok := ResolveCredential(p.ProviderID); ok && cred != "" {
			// Only the deterministic env key name is injected; never the raw
			// upstream key such as OPENAI_API_KEY.
			childEnv[p.EnvKey] = cred
		}
	}

	bin, err := exec.LookPath("grok")
	if err != nil {
		fmt.Fprintln(os.Stderr, "forge shell grok exec: grok binary not found on PATH; install Grok Build and retry (forge does not install it)")
		return 1
	}

	finalArgs := grok.WithDefaultPermission(grokArgs)
	cmd := exec.Command(bin, finalArgs...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	// Build the child environment, then suppress any FORGE_GROK_*_API_KEY
	// entries that are not in the current planned set. Identify those names
	// case-insensitively, but retain an entry only when its original variable
	// name exactly equals a canonical planned uppercase env key so that
	// inherited lower/mixed-case variants are stripped even when
	// strings.ToUpper(name) maps to a currently planned key.
	rawEnv := driver.BuildChildEnv(childEnv)
	filteredEnv := make([]string, 0, len(rawEnv))
	for _, entry := range rawEnv {
		key, _, ok := strings.Cut(entry, "=")
		if !ok {
			filteredEnv = append(filteredEnv, entry)
			continue
		}
		upper := strings.ToUpper(key)
		if strings.HasPrefix(upper, "FORGE_GROK_") && strings.HasSuffix(upper, "_API_KEY") {
			// Retain only when the original variable name exactly matches a
			// canonical planned uppercase env key. Casing variants are stripped
			// even when strings.ToUpper(key) maps to a currently planned key.
			if _, ok := childEnv[key]; !ok {
				continue
			}
		}
		filteredEnv = append(filteredEnv, entry)
	}
	cmd.Env = filteredEnv

	if err := cmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return exitErr.ExitCode()
		}
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}
