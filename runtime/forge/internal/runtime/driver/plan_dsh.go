package driver

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/dsh"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

// buildDSHPlan plans a DSH background agent invocation through the stable fdsh
// executable. Forge never drives DSH through emulation paths: the sole
// DialectDSH switch in BuildPlan dispatches exclusively here. The plan
// materializes an isolated per-run DSH_HOME under the prepared home parent,
// renders the loader overlay (injected llm-pi-ai providers, the selected
// model, the bridge insert naming the absolute plugin path that
// materializeDSHHome writes, and projected MCP servers), and carries
// launch-time credential env resolved only at launch. Native DSH resume is
// unsupported in this release and is rejected loudly before any side effect.
func buildDSHPlan(req PlanRequest) (CommandPlan, error) {
	spec := req.Spec
	if strings.TrimSpace(req.ResumeSessionID) != "" {
		return CommandPlan{}, fmt.Errorf("dsh: native resume is unsupported in this release")
	}

	// Project only representable MCP capabilities. Unsupported tool or Bash
	// contributions fail loudly before any filesystem side effect.
	var mcp []dsh.MCPServer
	if len(req.Capabilities) > 0 {
		result, err := resolveCapabilityResult(req.Capabilities, req.ResolveCapabilities)
		if err != nil {
			return CommandPlan{}, err
		}
		if len(result.Tools.Cap) > 0 || len(result.BashGate.Cap) > 0 {
			return CommandPlan{}, fmt.Errorf("dsh: unsupported capability contribution: only mcp projection is supported")
		}
		mcp = projectDSHMCPServers(result.Tools.MCP)
	}

	homeParent := strings.TrimSpace(spec.Runtime.HomeParent)
	homeEnvVar := strings.TrimSpace(spec.Runtime.HomeEnvVar)
	if homeEnvVar == "" {
		homeEnvVar = "DSH_HOME"
	}

	var home string
	var resources []ExecutionResource
	if homeParent != "" {
		dir, err := os.MkdirTemp(homeParent, "run-")
		if err != nil {
			return CommandPlan{}, fmt.Errorf("dsh: create per-run home: %w", err)
		}
		home = dir
		resources = append(resources, ExecutionResource{
			Path:               home,
			OwnershipRoot:      homeParent,
			RemoveOnSuccess:    true,
			RemoveOnCompletion: true,
		})
	}

	// The loader overlay base (providers with projected header env refs and the
	// selected model) comes from the prepared runtime patch; the bridge and MCP
	// insert rows are appended here so the isolated home's overlay names the
	// exact absolute plugin path that materializeDSHHome writes.
	base := dshRuntimeBasePatch(spec.Runtime)
	if base == nil {
		var err error
		base, err = dsh.RenderPatch(dsh.PatchInput{
			Providers:     dsh.InjectedProviders,
			SelectedModel: normalizeDSHModel(strings.TrimSpace(spec.Env[catalog.EnvDSHModel])),
			Version:       dsh.ProtocolVersion,
		})
		if err != nil {
			return CommandPlan{}, err
		}
	}
	bridgePluginPath := ""
	if home != "" {
		bridgePluginPath = filepath.Join(home, dsh.DefaultRuntimePatchAssets().Plugin.Filename)
	}
	rows, err := dsh.RenderInsertRows(bridgePluginPath, mcp)
	if err != nil {
		return CommandPlan{}, err
	}
	patch := append(append([]byte(nil), base...), rows...)

	if home != "" {
		if err := materializeDSHHome(home, spec.Runtime, patch); err != nil {
			return CommandPlan{}, fmt.Errorf("dsh: materialize home: %w", err)
		}
	}

	return CommandPlan{
		ProfileName: spec.Name,
		Dialect:     catalog.DialectDSH,
		Command:     []string{"fdsh", "--forge-agent", "--", req.Prompt},
		Env:         dshPlanEnv(spec, req.Permission, home, homeEnvVar),
		WorkDir:     dshPlanWorkDir(req.WorkDir),
		ConfigDir:   home,
		Permission:  req.Permission,
		Resources:   resources,
	}, nil
}

// dshRuntimeBasePatch returns the prepared loader overlay (patch.yaml) from the
// runtime preparation, or nil when no prepared patch is present so the planner
// falls back to a catalog render.
func dshRuntimeBasePatch(prep RuntimePreparation) []byte {
	for _, f := range prep.Files {
		if f.RelativePath == dsh.DefaultRuntimePatchAssets().PatchPath {
			return f.Data
		}
	}
	return nil
}

// materializeDSHHome writes the prepared runtime assets (bridge plugin and any
// prepared copies) into the fresh per-run home, then writes the deterministic
// provider/runtime patch. The patch is always rendered here so per-invocation
// MCP capability rows reach the child even when the composition root prepared
// a capability-free patch.
func materializeDSHHome(home string, prep RuntimePreparation, patch []byte) error {
	for _, f := range prep.Files {
		if strings.TrimSpace(f.RelativePath) == "" {
			continue
		}
		path := filepath.Join(home, f.RelativePath)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return err
		}
		mode := os.FileMode(f.Mode)
		if mode == 0 {
			mode = 0o600
		}
		if err := os.WriteFile(path, f.Data, mode); err != nil {
			return err
		}
	}
	for _, c := range prep.Copies {
		if strings.TrimSpace(c.RelativePath) == "" {
			continue
		}
		data, err := os.ReadFile(c.SourcePath)
		if err != nil {
			return err
		}
		path := filepath.Join(home, c.RelativePath)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return err
		}
		mode := os.FileMode(c.Mode)
		if mode == 0 {
			mode = 0o600
		}
		if err := os.WriteFile(path, data, mode); err != nil {
			return err
		}
	}
	return os.WriteFile(filepath.Join(home, "patch.yaml"), patch, 0o600)
}

// dshPlanEnv assembles the deterministic child environment: the resolved
// profile env (including DSH_MODEL), the launch-time credential env resolved
// by the composition root, the isolated per-run DSH_HOME, and the
// env-carried DSH permission mode.
func dshPlanEnv(spec ProfileSpec, permission catalog.PermissionMode, home, homeEnvVar string) map[string]string {
	env := make(map[string]string)
	for key, value := range spec.Env {
		env[key] = value
	}
	for key, value := range spec.Runtime.Env {
		env[key] = value
	}
	if home != "" {
		env[homeEnvVar] = home
	}
	// DSH permissions are env-carried, never CLI flags.
	env[catalog.EnvDSHPermissionMode] = catalog.DSHPermissionMode(permission)
	return env
}

func dshPlanWorkDir(workDir string) string {
	if strings.TrimSpace(workDir) != "" {
		return workDir
	}
	return "."
}

// projectDSHMCPServers maps neutral capability MCP servers onto DSH patch
// rows. HTTP URL servers use the streamable-http transport; command servers
// use stdio with sorted env overrides. The DSH package rejects any transport
// it cannot represent.
func projectDSHMCPServers(servers []CapabilityServer) []dsh.MCPServer {
	out := make([]dsh.MCPServer, 0, len(servers))
	for _, s := range servers {
		server := dsh.MCPServer{Name: s.Name}
		if strings.TrimSpace(s.URL) != "" {
			server.Transport = dsh.MCPTransportStreamableHTTP
		} else {
			server.Transport = dsh.MCPTransportStdio
			server.Command = s.Command
			server.Args = append([]string(nil), s.Args...)
			server.Env = sortedDSHEnvPairs(s.Env)
		}
		out = append(out, server)
	}
	return out
}

func sortedDSHEnvPairs(env map[string]string) []string {
	if len(env) == 0 {
		return nil
	}
	keys := make([]string, 0, len(env))
	for k := range env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	pairs := make([]string, 0, len(keys))
	for _, k := range keys {
		pairs = append(pairs, k+"="+env[k])
	}
	return pairs
}

// normalizeDSHModel maps a DSH_MODEL value (provider/model) onto the injected
// llm-pi-ai provider id space used by patch rendering. An already-injected id
// passes through; a bare injected name is prefixed; anything else is returned
// unchanged so RenderPatch rejects it loudly.
func normalizeDSHModel(model string) string {
	pid, mid, ok := strings.Cut(model, "/")
	if !ok || strings.TrimSpace(pid) == "" || strings.TrimSpace(mid) == "" {
		return strings.TrimSpace(model)
	}
	if _, ok := dsh.ProviderByID(pid); ok {
		return model
	}
	if p, ok := dsh.ProviderByID("llm-pi-ai." + pid); ok {
		return p.ID + "/" + mid
	}
	return model
}
