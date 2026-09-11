package discovery

import (
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/auth"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/cursor"
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
	// CursorModelAvailability, when set, is invoked at most once per list while
	// Cursor is authenticated. A failed check yields an empty/unknown map.
	CursorModelAvailability func() (map[string]cursor.Availability, error)
}

// ProvidersCommand runs the "forge providers" command.
func ProvidersCommand(deps ProviderDeps, args []string) int {
	if len(args) == 0 {
		return providersList(deps, args)
	}
	switch args[0] {
	case "list":
		return providersList(deps, args)
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
		ID                string                          `json:"id"`
		APIKind           string                          `json:"api_kind"`
		AuthOK            bool                            `json:"auth_ok"`
		ModelAvailability *map[string]cursor.Availability `json:"model_availability,omitempty"`
	}

	cursorAvailability := cursorAvailabilityForList(deps, filtered)
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
		item := entry{ID: name, APIKind: apiKind, AuthOK: authOK}
		if name == "cursor" && cursorAvailability != nil {
			item.ModelAvailability = cursorAvailability
		}
		entries = append(entries, item)
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

func cursorAvailabilityForList(deps ProviderDeps, names []string) *map[string]cursor.Availability {
	if deps.CursorModelAvailability == nil {
		return nil
	}
	authenticated := false
	for _, name := range names {
		if name != "cursor" {
			continue
		}
		if deps.AuthStatus != nil && deps.AuthStatus("cursor").OK {
			authenticated = true
		}
		break
	}
	if !authenticated {
		return nil
	}
	avail, err := deps.CursorModelAvailability()
	if err != nil || avail == nil {
		empty := map[string]cursor.Availability{}
		return &empty
	}
	projected := copyCursorAvailability(avail)
	return &projected
}

func copyCursorAvailability(in map[string]cursor.Availability) map[string]cursor.Availability {
	out := make(map[string]cursor.Availability, len(in))
	for id, av := range in {
		if id == "" || len(id) > 120 || strings.TrimSpace(id) != id {
			continue
		}
		if av.Status != cursor.StatusAvailable && av.Status != cursor.StatusBlocked && av.Status != cursor.StatusUnknown {
			continue
		}
		reason := ""
		switch av.Reason {
		case cursor.ReasonAdminBlocked, cursor.ReasonConsentRequired, cursor.ReasonModelDisabled, cursor.ReasonUnsupported:
			reason = av.Reason
		}
		copied := cursor.Availability{Status: av.Status}
		if av.Status == cursor.StatusBlocked && reason != "" {
			copied.Reason = reason
		}
		if existing, ok := out[id]; ok && existing != copied {
			out[id] = cursor.Availability{Status: cursor.StatusUnknown}
			continue
		}
		out[id] = copied
	}
	return out
}
