package catalog

import (
	"fmt"
	"sort"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers"
)

// Registry is a lookup table of Clients and Providers.
type Registry struct {
	clients   map[string]Client
	providers map[string]Provider
	models    map[string]ProviderModels
}

// NewRegistry creates a new empty Registry.
func NewRegistry() *Registry {
	return &Registry{
		clients:   map[string]Client{},
		providers: map[string]Provider{},
		models:    map[string]ProviderModels{},
	}
}

// DefaultRegistry builds the registry with all hardcoded clients and providers.
func DefaultRegistry() *Registry {
	r := NewRegistry()
	registerClients(r)
	providers.RegisterAll(r)
	return r
}

// RegisterDescriptor adds a client to the registry.
func (r *Registry) RegisterDescriptor(client Client) {
	r.clients[client.Name] = client
}

// RegisterBinding adds a provider to the registry.
func (r *Registry) RegisterBinding(provider Provider) {
	r.providers[provider.Name] = provider
}

// RegisterModels adds the provider-owned model definitions to the registry.
func (r *Registry) RegisterModels(providerID string, models ProviderModels) {
	cloned := make(ProviderModels, len(models))
	for id, model := range models {
		cloned[id] = model
	}
	r.models[providerID] = cloned
}

// LookupDescriptor returns the Client by name, or an error listing available
// clients. Error wording intentionally preserves the existing CLI contract.
func (r *Registry) LookupDescriptor(name string) (Client, error) {
	client, ok := r.clients[name]
	if !ok {
		return Client{}, unknownNameError("client descriptor", name, r.clientNames())
	}
	return client, nil
}

// LookupBinding returns the Provider by name, or an error listing available
// providers. Error wording intentionally preserves the existing CLI contract.
func (r *Registry) LookupBinding(name string) (Provider, error) {
	provider, ok := r.providers[name]
	if !ok {
		return Provider{}, unknownNameError("provider binding", name, r.providerNames())
	}
	return provider, nil
}

// ResolveBinding returns the effective Provider for a client, using the
// client's DefaultProvider when name is empty.
func (r *Registry) ResolveBinding(clientName, providerName string) (Client, Provider, error) {
	client, err := r.LookupDescriptor(clientName)
	if err != nil {
		return Client{}, Provider{}, err
	}
	if providerName == "" {
		providerName = client.DefaultProvider
	}
	provider, err := r.LookupBinding(providerName)
	if err != nil {
		return Client{}, Provider{}, fmt.Errorf("%s: %w", clientName, err)
	}
	if !provider.SupportsDialect(client.Dialect) {
		return Client{}, Provider{}, fmt.Errorf(
			"provider binding %q is not compatible with dialect %q (client %q); supported dialects: %s",
			providerName, client.Dialect, clientName, provider.DialectList(),
		)
	}
	return client, provider, nil
}

func (r *Registry) clientNames() []string {
	names := make([]string, 0, len(r.clients))
	for name := range r.clients {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// ClientNames returns the registered client names in stable order.
func (r *Registry) ClientNames() []string {
	return r.clientNames()
}

func (r *Registry) providerNames() []string {
	names := make([]string, 0, len(r.providers))
	for name := range r.providers {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// BindingNames returns the registered provider names in stable order.
func (r *Registry) BindingNames() []string {
	return r.providerNames()
}

// LookupProviderModel checks whether a model is owned by the given canonical
// provider. Returns the canonical model id and true if found.
func (r *Registry) LookupProviderModel(providerID, modelID string) (string, bool) {
	models, ok := r.models[providerID]
	if !ok {
		return "", false
	}
	def, ok := models[modelID]
	if !ok {
		return "", false
	}
	return def.ID, ok
}

// ProviderModels returns the set of models owned by the given canonical
// provider, or nil if the provider is unknown.
func (r *Registry) ProviderModels(providerID string) map[string]ModelDef {
	models := r.models[providerID]
	if models == nil {
		return nil
	}
	out := make(map[string]ModelDef, len(models))
	for id, model := range models {
		out[id] = model
	}
	return out
}

// ProviderEntries returns all provider entries with their model definitions.
type ProviderEntry struct {
	ID     string
	Models []ModelDef
}

// Providers returns all registered provider entries with their model
// definitions, in deterministic provider name order.
func (r *Registry) Providers() []ProviderEntry {
	names := make([]string, 0, len(r.providers))
	for name := range r.providers {
		names = append(names, name)
	}
	sort.Strings(names)
	var entries []ProviderEntry
	for _, name := range names {
		entry := ProviderEntry{ID: name}
		if models, ok := r.models[name]; ok {
			for _, m := range models {
				entry.Models = append(entry.Models, m)
			}
			sort.Slice(entry.Models, func(i, j int) bool {
				return entry.Models[i].ID < entry.Models[j].ID
			})
		}
		entries = append(entries, entry)
	}
	return entries
}

func unknownNameError(kind, name string, available []string) error {
	return fmt.Errorf("unknown %s %q; available: %s", kind, name, strings.Join(available, ", "))
}
