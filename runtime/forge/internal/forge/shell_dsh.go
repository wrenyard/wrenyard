package forge

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/dsh"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/auth"
)

// FDSH stable launcher contract.
const (
	// fdshMarkerEnv is set by the POSIX fdsh launcher before exec'ing the
	// current Forge target so the versioned binary still recognizes itself as
	// an fdsh invocation (its basename is "forge").
	fdshMarkerEnv = "FORGE_FDSH_MARKER"

	// dshSupportedProtocolLine is the exact protocol line emitted by the real
	// dsh dialect for which the Forge model patch is validated.
	dshSupportedProtocolLine = "@deepseek-ai/dsh@0.1.0-rc.6"

	// dshProtocolToken is the version token accepted inside the protocol line.
	dshProtocolToken = "0.1.0-rc.6"

	// dshDefaultProfile is the DSH Web profile opened by default when fdsh is
	// invoked without an explicit --profile.
	dshDefaultProfile = "web"

	// dshAgentProfile is the one-shot profile used by Forge background Agent
	// dispatch when no explicit profile was supplied.
	dshAgentProfile = "headless"

	// dshForgeAgentFlag is the hidden marker used by the Forge background Agent
	// to launch against a driver-provisioned isolated DSH home. It is internal
	// and never documented in help output.
	dshForgeAgentFlag = "--forge-agent"

	// dshModelPatchFilename is the Forge-managed secret-free model patch file
	// mounted into the active DSH home.
	dshModelPatchFilename = "forge-model-patch.yaml"

	// dshModelPatchEnv is the env var that points the real dsh at the
	// Forge-managed model patch. The real dsh reads this to mount the public
	// llm-pi-ai providers (zhipu-coding, kimi-coding).
	dshModelPatchEnv = "DSH_FORGE_MODEL_PATCH"

	// dshCredentialEnvPrefix is the inherited env prefix that must never be
	// forwarded into a dsh child process because it carries credentials.
	dshCredentialEnvPrefix = "FORGE_DSH_"
)

// runFDSHIfNeeded detects a stable fdsh invocation and dispatches to the
// Forge-owned DSH launcher. It is wired from shell.go's exported wrapper so
// cmd/forge can call it before normal CLI/stable-launcher handling.
func runFDSHIfNeeded() (int, bool) {
	if !fdshRequested() {
		return 0, false
	}
	plan, err := buildDSHPlan(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1, true
	}
	return execDSHPlan(plan), true
}

func fdshRequested() bool {
	if os.Getenv(fdshMarkerEnv) == "1" {
		return true
	}
	switch filepath.Base(os.Args[0]) {
	case "fdsh", "fdsh.exe":
		return true
	}
	return false
}

// runShellDSHCommand routes `forge shell dsh plan|exec` for inspection and
// launch. The hidden --forge-agent mode is internal and never documented.
func runShellDSHCommand(args []string) int {
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
		fmt.Fprintln(os.Stdout, "usage: forge shell dsh plan|exec [fdsh args...]")
		return 0
	}
	switch args[0] {
	case "plan":
		plan, err := buildDSHPlan(args[1:])
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		printDSHPlan(plan)
		return 0
	case "exec":
		plan, err := buildDSHPlan(args[1:])
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		return execDSHPlan(plan)
	default:
		fmt.Fprintln(os.Stderr, "usage: forge shell dsh plan|exec [fdsh args...]")
		return 2
	}
}

// dshPlan is the resolved, inspectable launch plan for the real dsh dialect.
type dshPlan struct {
	RealDSHPath string
	Version     string
	Mode        string
	Profile     string
	DSHHome     string
	PatchPath   string
	Args        []string
	Env         []string
}

func buildDSHPlan(args []string) (dshPlan, error) {
	real, err := resolveRealDSH()
	if err != nil {
		return dshPlan{}, err
	}
	version, err := dshProtocolVersion(real)
	if err != nil {
		return dshPlan{}, err
	}
	if !strings.Contains(version, dshProtocolToken) {
		return dshPlan{}, fmt.Errorf("fdsh: unsupported dsh %q; require protocol %s", version, dshSupportedProtocolLine)
	}

	profile, agent, rest, err := parseFDSHArgs(args)
	if err != nil {
		return dshPlan{}, err
	}
	if profile == "" {
		if agent {
			profile = dshAgentProfile
		} else {
			profile = dshDefaultProfile
		}
	}

	home, err := dshHomeFor(agent)
	if err != nil {
		return dshPlan{}, err
	}
	creds := resolveDSHCredentials()
	if err := dsh.ValidateCredentials(creds); err != nil {
		return dshPlan{}, fmt.Errorf("fdsh: invalid dsh credentials: %w", err)
	}
	projections := dsh.ProjectProviders(creds)

	var patchPath string
	if agent {
		patchPath, err = dshAgentPatchPath(home)
	} else {
		patchPath, err = ensureDSHModelPatch(home, projections)
	}
	if err != nil {
		return dshPlan{}, err
	}

	childEnv := dsh.LaunchEnv(creds, scrubInheritedFDSHEnv(os.Environ()))
	childEnv = withEnv(childEnv, "DSH_HOME", home)
	if !agent {
		childEnv = withEnv(childEnv, dshModelPatchEnv, patchPath)
	}

	mode := "web"
	if agent {
		mode = "agent"
	}
	launchArgs, err := composeDSHArgs(profile, rest, patchPath)
	if err != nil {
		return dshPlan{}, err
	}
	return dshPlan{
		RealDSHPath: real,
		Version:     version,
		Mode:        mode,
		Profile:     profile,
		DSHHome:     home,
		PatchPath:   patchPath,
		Args:        launchArgs,
		Env:         childEnv,
	}, nil
}

// composeDSHArgs keeps user patch layers in their original order, applies the
// Forge patch last, then forwards profile arguments and the positional task.
// DSH requires global --patch options before a headless task positional.
func composeDSHArgs(profile string, rest []string, forgePatch string) ([]string, error) {
	patchArgs := make([]string, 0, len(rest)+2)
	forwarded := make([]string, 0, len(rest))
	for i := 0; i < len(rest); i++ {
		arg := rest[i]
		if arg == "--" {
			forwarded = append(forwarded, rest[i:]...)
			break
		}
		switch {
		case arg == "--patch":
			if i+1 >= len(rest) {
				return nil, fmt.Errorf("fdsh: --patch requires a value")
			}
			patchArgs = append(patchArgs, arg, rest[i+1])
			i++
		case strings.HasPrefix(arg, "--patch="):
			if strings.TrimSpace(strings.TrimPrefix(arg, "--patch=")) == "" {
				return nil, fmt.Errorf("fdsh: --patch requires a value")
			}
			patchArgs = append(patchArgs, arg)
		default:
			forwarded = append(forwarded, arg)
		}
	}
	args := make([]string, 0, 2+len(patchArgs)+2+len(forwarded))
	args = append(args, "--profile", profile)
	args = append(args, patchArgs...)
	args = append(args, "--patch", forgePatch)
	return append(args, forwarded...), nil
}

// parseFDSHArgs splits fdsh args into the effective profile, the hidden agent
// marker, and the remaining arguments forwarded to the real dsh. An explicit
// --profile is preserved; the hidden --forge-agent is consumed and never
// forwarded.
func parseFDSHArgs(args []string) (profile string, agent bool, rest []string, err error) {
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == dshForgeAgentFlag:
			agent = true
		case arg == "--":
			rest = append(rest, args[i:]...)
			return profile, agent, rest, nil
		case arg == "--profile":
			if i+1 >= len(args) {
				return "", false, nil, fmt.Errorf("fdsh: --profile requires a value")
			}
			profile = args[i+1]
			i++
		case strings.HasPrefix(arg, "--profile="):
			profile = strings.TrimPrefix(arg, "--profile=")
		default:
			rest = append(rest, arg)
		}
	}
	return profile, agent, rest, nil
}

func resolveRealDSH() (string, error) {
	if configured := strings.TrimSpace(os.Getenv("FORGE_DSH_BIN")); configured != "" {
		abs, err := filepath.Abs(configured)
		if err != nil {
			return "", fmt.Errorf("fdsh: resolve FORGE_DSH_BIN: %w", err)
		}
		return abs, nil
	}
	path, err := exec.LookPath("dsh")
	if err != nil {
		return "", errors.New("fdsh: real dsh dialect not found on PATH; install @deepseek-ai/dsh or set FORGE_DSH_BIN")
	}
	return path, nil
}

func dshProtocolVersion(path string) (string, error) {
	out, err := exec.Command(path, "--version").CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("fdsh: run %s --version: %w", path, err)
	}
	line := strings.TrimSpace(string(out))
	if line == "" {
		return "", fmt.Errorf("fdsh: %s --version produced no output", path)
	}
	return line, nil
}

// dshHomeFor returns the DSH home used for the launch. Web mode uses the
// user's normal DSH home. Hidden agent mode requires the isolated DSH_HOME
// provisioned by the Forge background Agent driver and never creates a
// per-PID home.
func dshHomeFor(agent bool) (string, error) {
	if agent {
		if h := strings.TrimSpace(os.Getenv("DSH_HOME")); h != "" {
			return h, nil
		}
		return "", fmt.Errorf("fdsh: --forge-agent requires a driver-provided DSH_HOME")
	}
	if h := strings.TrimSpace(os.Getenv("DSH_HOME")); h != "" {
		return h, nil
	}
	return filepath.Join(userHome(), ".dsh"), nil
}

// dshAgentPatchPath reuses the runtime patch asset the driver already rendered
// into the agent DSH_HOME. It never writes or overwrites anything: only
// Web/profile mode maintains the Forge catalog patch.
func dshAgentPatchPath(home string) (string, error) {
	patchPath := filepath.Join(home, dsh.DefaultRuntimePatchAssets().PatchPath)
	if !exists(patchPath) {
		return "", fmt.Errorf("fdsh: --forge-agent requires an existing runtime patch at %s", patchPath)
	}
	return patchPath, nil
}

// ensureDSHModelPatch renders the Forge-managed secret-free model patch from
// the projected providers (env refs only, never credential values) and writes
// it atomically into the active DSH home. Only Web/profile mode maintains this
// catalog patch; hidden agent mode reuses the driver-rendered runtime patch
// instead. It never writes a DSH Profile.
func ensureDSHModelPatch(home string, projections []dsh.ProviderProjection) (string, error) {
	patchPath := filepath.Join(home, dshModelPatchFilename)
	providers := make([]dsh.Provider, 0, len(projections))
	for _, proj := range projections {
		providers = append(providers, proj.Provider)
	}
	rendered, err := dsh.RenderPatch(dsh.PatchInput{Providers: providers})
	if err != nil {
		return "", fmt.Errorf("fdsh: render model patch: %w", err)
	}
	if err := writeFileAtomic(patchPath, string(rendered)); err != nil {
		return "", fmt.Errorf("fdsh: write model patch %s: %w", patchPath, err)
	}
	return patchPath, nil
}

// dshCredentialResolver is a test seam over the typed auth store so FDSH tests
// can inject token plus HTTP context headers without touching the real auth
// files. The default resolves every provider through the typed
// authStatusResolver().Credential resolver, never ResolveCredential.
var dshCredentialResolver = func(providerID string) (dsh.TypedCredential, bool) {
	cred, ok := authStatusResolver().Credential(providerID)
	if !ok {
		return dsh.TypedCredential{}, false
	}
	return authTypedCredential(cred), true
}

// authTypedCredential flattens a typed auth.Credential (token plus http.Header)
// onto the secret-free dsh typed credential projection input.
func authTypedCredential(cred *auth.Credential) dsh.TypedCredential {
	headers := map[string]string{}
	for name, values := range cred.ContextHeaders() {
		if len(values) > 0 {
			headers[name] = values[0]
		}
	}
	return dsh.TypedCredential{Token: cred.Value, Headers: headers}
}

// resolveDSHCredentials resolves typed credentials (token plus context headers)
// for the injected llm-pi-ai providers. The patch itself is secret-free;
// credential values only reach the dsh child process through its environment.
func resolveDSHCredentials() dsh.Credentials {
	creds := dsh.Credentials{}
	for _, provider := range dsh.InjectedProviders {
		forgeID := strings.TrimPrefix(provider.ID, "llm-pi-ai.")
		typed, ok := dshCredentialResolver(forgeID)
		if !ok {
			continue
		}
		if strings.TrimSpace(typed.Token) == "" && !hasDSHTypedHeader(typed.Headers) {
			continue
		}
		creds[provider.ID] = typed
	}
	return creds
}

func hasDSHTypedHeader(headers map[string]string) bool {
	for name, value := range headers {
		if strings.EqualFold(name, "Authorization") {
			continue
		}
		if strings.TrimSpace(value) != "" {
			return true
		}
	}
	return false
}

// scrubInheritedFDSHEnv drops inherited FORGE_DSH_* credential vars (and the
// fdsh marker) so no parent credential can leak into the dsh child process.
func scrubInheritedFDSHEnv(base []string) []string {
	scrubbed := make([]string, 0, len(base))
	for _, kv := range base {
		key := kv
		if i := strings.IndexByte(kv, '='); i >= 0 {
			key = kv[:i]
		}
		if strings.HasPrefix(key, dshCredentialEnvPrefix) || key == fdshMarkerEnv {
			continue
		}
		scrubbed = append(scrubbed, kv)
	}
	return scrubbed
}

// withEnv returns env with key=value set exactly once, removing any existing
// occurrence.
func withEnv(env []string, key, value string) []string {
	out := make([]string, 0, len(env)+1)
	prefix := key + "="
	for _, kv := range env {
		if strings.HasPrefix(kv, prefix) {
			continue
		}
		out = append(out, kv)
	}
	return append(out, key+"="+value)
}

func envKeys(env []string) []string {
	keys := make([]string, 0, len(env))
	for _, kv := range env {
		key := kv
		if i := strings.IndexByte(kv, '='); i >= 0 {
			key = kv[:i]
		}
		keys = append(keys, key)
	}
	return keys
}

func printDSHPlan(plan dshPlan) {
	fmt.Fprintf(os.Stdout, "real dsh: %s\n", plan.RealDSHPath)
	fmt.Fprintf(os.Stdout, "protocol: %s\n", plan.Version)
	fmt.Fprintf(os.Stdout, "mode: %s\n", plan.Mode)
	fmt.Fprintf(os.Stdout, "profile: %s\n", plan.Profile)
	fmt.Fprintf(os.Stdout, "dsh home: %s\n", plan.DSHHome)
	fmt.Fprintf(os.Stdout, "model patch: %s\n", plan.PatchPath)
	fmt.Fprintf(os.Stdout, "args: dsh %s\n", strings.Join(plan.Args, " "))
	fmt.Fprintf(os.Stdout, "env keys: %s\n", strings.Join(envKeys(plan.Env), " "))
}

func execDSHPlan(plan dshPlan) int {
	return runChild(plan.RealDSHPath, plan.Args, plan.Env)
}

func writeFileAtomic(path, content string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o644); err != nil {
		return err
	}
	if runtime.GOOS == "windows" {
		_ = os.Remove(path)
	}
	return os.Rename(tmp, path)
}
