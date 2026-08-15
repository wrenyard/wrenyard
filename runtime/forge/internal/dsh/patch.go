package dsh

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// ProtocolVersion is the @deepseek-ai/dsh client protocol this package
// renders patches for.
const ProtocolVersion = "0.1.0-rc.6"

// Loader overlay row ids pinned by the rc.6 protocol. The providers and the
// selected default model are targeted by id; the bridge plugin and each MCP
// server are injected rows.
const (
	// llmPIAIProviderRowID targets the injected provider group by id.
	llmPIAIProviderRowID = "llm-pi-ai"
	// agentDefaultModelRowID targets the selected default model by id.
	agentDefaultModelRowID = "agent-default-model"
	// BridgeRowID is the loader overlay insert id for the Forge bridge plugin.
	BridgeRowID = "forge-dsh-bridge"
	// MCPClientRowID is the loader overlay insert id for injected MCP clients.
	MCPClientRowID = "@deepseek-ai/dsh-mcp-client"
)

// ToolCapability is a capability projection requested at launch time. Only
// MCP projection is supported in this release; any other capability fails
// loudly.
type ToolCapability string

const (
	// ToolMCP is the supported MCP capability projection.
	ToolMCP ToolCapability = "mcp"
	// ToolBash is unsupported; requesting it fails loudly.
	ToolBash ToolCapability = "bash"
	// ToolFS is an unsupported non-MCP tool; requesting it fails loudly.
	ToolFS ToolCapability = "fs"
)

// MCPTransport is the transport of an MCP capability row.
type MCPTransport string

const (
	// MCPTransportStdio renders a stdio MCP server row.
	MCPTransportStdio MCPTransport = "stdio"
	// MCPTransportStreamableHTTP renders a streamable-http MCP server row.
	MCPTransportStreamableHTTP MCPTransport = "streamable-http"
)

// MCPServer is a single projected MCP capability row. Env overrides never
// carry credentials from this package.
type MCPServer struct {
	Name      string
	Transport MCPTransport
	Command   string
	Args      []string
	Env       []string
}

// PatchInput is the complete secret-free input to RenderPatch.
type PatchInput struct {
	Providers        []Provider
	SelectedModel    string
	MCPServers       []MCPServer
	Tools            []ToolCapability
	Version          string
	BridgePluginPath string // absolute plugin path; empty emits no bridge insert row
}

var yamlPlainRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._@/\-]*$`)

func yamlStr(s string) string {
	if yamlPlainRe.MatchString(s) {
		return s
	}
	return fmt.Sprintf("%q", s)
}

// RenderPatch renders the deterministic, secret-free DSH loader overlay for
// the @deepseek-ai/dsh 0.1.0-rc.6 protocol. The overlay is a top-level YAML
// array: an llm-pi-ai row whose config.providers dict is keyed by canonical
// route (id without the llm-pi-ai. prefix), an optional agent-default-model
// row, and bridge/MCP insert rows. Every credential is a literal unquoted
// !!js process.env.<ENV> tag, never a value, so the file never holds a
// credential. The native deepseek-official routes are never re-emitted.
// agent-default-model is only ever added for an explicit SelectedModel. MCP
// capability rows are rendered for stdio and streamable-http transports;
// unsupported tools or Bash additions are rejected loudly.
func RenderPatch(in PatchInput) ([]byte, error) {
	if in.Version == "" {
		in.Version = ProtocolVersion
	}
	providers := cloneProviders(in.Providers)

	for _, tool := range in.Tools {
		if tool != ToolMCP {
			return nil, fmt.Errorf("dsh: unsupported tool capability %q: only mcp projection is supported", tool)
		}
	}

	selected, err := resolveSelection(providers, in.SelectedModel)
	if err != nil {
		return nil, err
	}

	var b strings.Builder
	b.WriteString("# forge dsh patch (generated; secret-free)\n")

	// llm-pi-ai loader row: providers dict keyed by canonical route.
	b.WriteString("- id: " + yamlStr(llmPIAIProviderRowID) + "\n")
	b.WriteString("  config:\n")
	b.WriteString("    providers:\n")
	for _, p := range providers {
		routeKey := RouteKey(p)
		b.WriteString("      " + yamlStr(routeKey) + ":\n")
		b.WriteString("        displayName: " + yamlStr(displayNameFor(routeKey)) + "\n")
		b.WriteString("        api: " + yamlStr(string(p.APIType)) + "\n")
		b.WriteString("        apiKeyEnv: " + yamlStr(p.APIKeyEnv) + "\n")
		b.WriteString("        baseURL: " + yamlStr(NormalizeBaseURL(p.BaseURL)) + "\n")
		b.WriteString("        models:\n")
		for _, m := range p.Models {
			b.WriteString("          - id: " + yamlStr(m.ID) + "\n")
			if strings.TrimSpace(m.Label) != "" {
				b.WriteString("            name: " + yamlStr(m.Label) + "\n")
			}
			if m.ContextWindow > 0 {
				b.WriteString("            contextWindow: " + fmt.Sprintf("%d", m.ContextWindow) + "\n")
			}
			if m.MaxTokens > 0 {
				b.WriteString("            maxTokens: " + fmt.Sprintf("%d", m.MaxTokens) + "\n")
			}
			if m.Reasoning {
				b.WriteString("            reasoningEfforts:\n")
				b.WriteString("              off:\n")
				b.WriteString("              high: high\n")
			}
		}
		if headerNames := sortedNonAuthHeaders(p.Headers); len(headerNames) > 0 {
			b.WriteString("        headers:\n")
			for _, name := range headerNames {
				b.WriteString("          " + yamlStr(name) + ": " + envRefTag(p.Headers[name]) + "\n")
			}
		}
	}

	if selected != "" {
		pid, mid, _ := splitSelection(selected)
		b.WriteString("- id: " + yamlStr(agentDefaultModelRowID) + "\n")
		b.WriteString("  config:\n")
		b.WriteString("    provider: " + yamlStr(pid) + "\n")
		b.WriteString("    model: " + yamlStr(mid) + "\n")
	}

	rows, err := RenderInsertRows(in.BridgePluginPath, in.MCPServers)
	if err != nil {
		return nil, err
	}
	b.Write(rows)
	return []byte(b.String()), nil
}

// RenderInsertRows renders the loader overlay insert rows for the bridge
// plugin and MCP servers as a YAML fragment appended to a base overlay. The
// bridge row is emitted only when bridgePluginPath is non-empty; MCP rows are
// sorted by server name and carry env/header refs as unquoted !!js tags.
func RenderInsertRows(bridgePluginPath string, servers []MCPServer) ([]byte, error) {
	for _, srv := range servers {
		if srv.Transport != MCPTransportStdio && srv.Transport != MCPTransportStreamableHTTP {
			return nil, fmt.Errorf("dsh: unsupported mcp transport %q", srv.Transport)
		}
	}
	sorted := append([]MCPServer(nil), servers...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Name < sorted[j].Name })

	var b strings.Builder
	if strings.TrimSpace(bridgePluginPath) != "" {
		b.WriteString("- insert:\n")
		b.WriteString("    id: " + yamlStr(BridgeRowID) + "\n")
		b.WriteString("    name: " + yamlStr(bridgePluginPath) + "\n")
	}
	for _, srv := range sorted {
		b.WriteString("- insert:\n")
		b.WriteString("    id: " + yamlStr(MCPClientRowID) + "\n")
		b.WriteString("    serverName: " + yamlStr(srv.Name) + "\n")
		b.WriteString("    transport: " + yamlStr(string(srv.Transport)) + "\n")
		b.WriteString("    config:\n")
		if srv.Transport == MCPTransportStdio {
			b.WriteString("      command: " + yamlStr(srv.Command) + "\n")
			if len(srv.Args) > 0 {
				b.WriteString("      args:\n")
				for _, a := range srv.Args {
					b.WriteString("        - " + yamlStr(a) + "\n")
				}
			}
		}
		if len(srv.Env) > 0 {
			env := append([]string(nil), srv.Env...)
			sort.Strings(env)
			b.WriteString("      env:\n")
			for _, e := range env {
				key, value, ok := strings.Cut(e, "=")
				if !ok {
					continue
				}
				b.WriteString("        " + yamlStr(key) + ": " + yamlValue(value) + "\n")
			}
		}
	}
	return []byte(b.String()), nil
}

// envRefTag is an unquoted YAML tag dereferencing an env var at load time.
func envRefTag(envName string) string {
	return "!!js process.env." + envName
}

// yamlValue renders a config value, passing through explicit !!js tags raw so
// they stay unquoted.
func yamlValue(v string) string {
	if strings.HasPrefix(v, "!!js ") {
		return v
	}
	return yamlStr(v)
}

// displayNameFor derives a stable human-facing route display name.
func displayNameFor(routeKey string) string {
	words := strings.Split(routeKey, "-")
	for i, w := range words {
		if w == "" {
			continue
		}
		words[i] = strings.ToUpper(w[:1]) + w[1:]
	}
	return strings.Join(words, " ")
}

// sortedNonAuthHeaders returns the sorted header names of p excluding
// Authorization, which is handled solely by apiKeyEnv.
func sortedNonAuthHeaders(headers map[string]string) []string {
	names := make([]string, 0, len(headers))
	for name := range headers {
		if strings.EqualFold(name, "Authorization") {
			continue
		}
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func cloneProviders(src []Provider) []Provider {
	if src == nil {
		src = InjectedProviders
	}
	out := make([]Provider, 0, len(src))
	for _, p := range src {
		cp := p
		cp.Models = append([]Model(nil), p.Models...)
		if p.Headers != nil {
			headers := make(map[string]string, len(p.Headers))
			for k, v := range p.Headers {
				headers[k] = v
			}
			cp.Headers = headers
		}
		out = append(out, cp)
	}
	return out
}

func resolveSelection(providers []Provider, sel string) (string, error) {
	if sel == "" {
		return "", nil
	}
	pid, mid, err := splitSelection(sel)
	if err != nil {
		return "", err
	}
	for _, p := range providers {
		if p.ID != pid {
			continue
		}
		for _, m := range p.Models {
			if m.ID == mid {
				return sel, nil
			}
		}
	}
	return "", fmt.Errorf("dsh: selected model %q is not projected by any provider", sel)
}

func splitSelection(sel string) (pid, mid string, err error) {
	i := strings.LastIndex(sel, "/")
	if i <= 0 || i == len(sel)-1 {
		return "", "", fmt.Errorf("dsh: selected model %q must be providerID/modelID", sel)
	}
	return sel[:i], sel[i+1:], nil
}
