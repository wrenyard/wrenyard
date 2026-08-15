package discovery

import (
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/auth"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

// ProviderDeps bundles explicit callbacks for the providers discovery command.
type ProviderDeps struct {
	CatalogRegistry *catalog.Registry
	Auth            ProviderAuthDeps
	HasFlag         func(args []string, flag string) bool
	PrintJSON       func(value interface{}) int
	// AuthStatus resolves authentication status for all resolver types.
	AuthStatus func(providerID string) auth.ProviderAuthStatus
}

// ProvidersCommand runs the "forge providers" command.
func ProvidersCommand(deps ProviderDeps, args []string) int {
	if len(args) == 0 {
		return providersList(deps, args)
	}
	switch args[0] {
	case "list":
		return providersList(deps, args)
	case "describe":
		return providersDescribe(deps, args[1:])
	case "auth":
		return providersAuth(deps, args[1:])
	default:
		fmt.Fprintf(os.Stderr, "forge providers: unknown subcommand %s\n", args[0])
		return 2
	}
}

func providersList(deps ProviderDeps, args []string) int {
	reg := deps.CatalogRegistry
	names := reg.BindingNames()
	// Filter to public canonical provider ids only.
	public := canonicalProviderIDs(deps.CatalogRegistry)
	publicSet := make(map[string]bool, len(public))
	for _, id := range public {
		publicSet[id] = true
	}
	var filtered []string
	for _, name := range names {
		if publicSet[name] {
			filtered = append(filtered, name)
		}
	}
	if len(filtered) == 0 {
		fmt.Fprintln(os.Stdout, "No providers registered.")
		return 0
	}

	type entry struct {
		ID      string `json:"id"`
		APIKind string `json:"api_kind"`
		AuthOK  bool   `json:"auth_ok"`
	}

	entries := make([]entry, 0, len(filtered))
	for _, name := range filtered {
		binding, err := reg.LookupBinding(name)
		authOK := false
		if err == nil && (binding.Inference != nil || binding.UsesClientBinary()) {
			// Use the unified auth status for all resolvers.
			if deps.AuthStatus != nil {
				status := deps.AuthStatus(name)
				authOK = status.OK
			}
		}
		apiKind := ""
		if err == nil && binding.Inference != nil {
			apiKind = binding.Inference.Protocol
		}
		entries = append(entries, entry{ID: name, APIKind: apiKind, AuthOK: authOK})
	}

	if deps.HasFlag(args, "--json") {
		return deps.PrintJSON(entries)
	}

	sort.Slice(entries, func(i, j int) bool { return entries[i].ID < entries[j].ID })
	for _, e := range entries {
		authState := "native"
		binding, err := reg.LookupBinding(e.ID)
		if err == nil && (binding.Inference != nil || binding.UsesClientBinary()) {
			if deps.AuthStatus != nil {
				status := deps.AuthStatus(e.ID)
				if status.Kind == auth.ResolverForgeManaged {
					authState = "missing"
					if status.OK {
						authState = "authenticated"
					}
				} else {
					if status.OK {
						authState = "authenticated"
					} else {
						authState = "missing"
					}
				}
			} else if binding.Inference != nil && binding.Inference.CredentialResolver == "forge-managed" {
				authState = "missing"
				if e.AuthOK {
					authState = "authenticated"
				}
			}
		}
		fmt.Printf("%-30s %-24s %s\n", e.ID, e.APIKind, authState)
	}
	return 0
}

// canonicalProviderIDs returns the public canonical provider ids in
// deterministic order, excluding internal providers such as opencode-native.
// A binding is public when it declares an inference transport or runs through
// a client binary.
func canonicalProviderIDs(reg *catalog.Registry) []string {
	ids := []string{}
	for _, id := range reg.BindingNames() {
		binding, err := reg.LookupBinding(id)
		if err == nil && (binding.Inference != nil || binding.UsesClientBinary()) {
			ids = append(ids, id)
		}
	}
	return ids
}

func providersAuth(deps ProviderDeps, args []string) int {
	if len(args) < 2 {
		fmt.Fprintln(os.Stderr, "forge providers auth: expected login or logout")
		return 2
	}
	op := args[0]
	name := args[1]

	reg := deps.CatalogRegistry
	binding, err := reg.LookupBinding(name)
	if err != nil {
		fmt.Fprintf(os.Stderr, "forge providers auth: unknown provider %q\n", name)
		return 2
	}
	if binding.CredentialSource() != catalog.CredentialResolverForgeManaged {
		fmt.Fprintf(os.Stderr, "forge providers auth: provider %q does not support auth\n", name)
		return 2
	}

	switch op {
	case "login":
		if deps.Auth.ProviderLogin == nil {
			fmt.Fprintln(os.Stderr, "forge providers auth login: not available")
			return 1
		}
		if err := deps.Auth.ProviderLogin(name); err != nil {
			fmt.Fprintf(os.Stderr, "forge providers auth login: %v\n", err)
			return 1
		}
		return 0
	case "logout":
		if deps.Auth.ProviderLogout == nil {
			fmt.Fprintln(os.Stderr, "forge providers auth logout: not available")
			return 1
		}
		if err := deps.Auth.ProviderLogout(name); err != nil {
			fmt.Fprintf(os.Stderr, "forge providers auth logout: %v\n", err)
			return 1
		}
		return 0
	default:
		fmt.Fprintf(os.Stderr, "forge providers auth: expected login or logout, got %s\n", op)
		return 2
	}
}

// providersDescribe reports every canonical provider and its native raw LLM
// protocols derived from catalog capability metadata. JSON protocol values are
// the canonical "openai"/"anthropic"; unsupported providers expose an empty
// list rather than an inferred Inference.Protocol.
func providersDescribe(deps ProviderDeps, args []string) int {
	reg := deps.CatalogRegistry

	prio := map[string]int{"openai": 0, "anthropic": 1}

	type providerDesc struct {
		ID     string   `json:"id"`
		RawLLM []string `json:"raw_llm"`
	}

	public := canonicalProviderIDs(deps.CatalogRegistry)
	descs := make([]providerDesc, 0, len(public))
	for _, name := range public {
		var raw []string
		if binding, err := reg.LookupBinding(name); err == nil {
			for _, c := range binding.RawLLM {
				raw = append(raw, string(c.Protocol))
			}
		}
		sort.Slice(raw, func(i, j int) bool { return prio[raw[i]] < prio[raw[j]] })
		descs = append(descs, providerDesc{ID: name, RawLLM: raw})
	}

	if deps.HasFlag(args, "--json") {
		return deps.PrintJSON(descs)
	}

	for _, d := range descs {
		protocols := strings.Join(d.RawLLM, ", ")
		if protocols == "" {
			protocols = "none"
		}
		fmt.Printf("%-20s %s\n", d.ID, protocols)
	}
	return 0
}
