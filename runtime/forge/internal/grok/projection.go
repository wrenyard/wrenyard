package grok

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

// ModelIDPrefix is the stable prefix for every Forge-managed Grok model id.
const ModelIDPrefix = "forge-"

// APIBackend is the inference backend every projected model uses in v1.
const APIBackend = "chat_completions"

// Projection is a single Forge-model-to-Grok-model projection. It carries no
// credential value; only the deterministic env_key name is exposed so the
// launch environment can be populated by the caller.
type Projection struct {
	// ID is the Grok model id: forge-<provider-id>--<normalized-model-id>.
	ID string
	// Name is a human-readable display name (provider · model).
	Name string
	// Model is the real upstream model id sent to the provider endpoint.
	Model string
	// BaseURL is the Grok projection base URL: the provider's raw OpenAI
	// BaseEndpoint with the /chat/completions suffix stripped so that the
	// chat_completions backend can append the route without doubling it.
	BaseURL string
	// EnvKey is the deterministic FORGE_GROK_<SCREAMING_PROVIDER>_API_KEY name.
	EnvKey string
	// APIBackend is always "chat_completions" in v1.
	APIBackend string
	// SupportsBackendSearch is always false in v1 (no third-party web search).
	SupportsBackendSearch bool
	// ContextWindow is the explicit catalog context window in tokens.
	ContextWindow int
	// ProviderID is the canonical Forge provider id (for credential lookup).
	ProviderID string
}

// SkipReason describes why a provider or model was excluded from projection.
// It is fully deterministic and never contains secret material.
type SkipReason struct {
	ProviderID string
	ModelID    string
	Reason     string
}

// EligibleProjections evaluates the full default catalog registry and returns
// the eligible projections together with deterministic, redacted skip reasons
// for every excluded provider/model. resolveCredential must return (value, ok)
// where ok reports whether a non-empty Forge-managed credential exists; the
// value is never inspected or stored here.
func EligibleProjections(reg *catalog.Registry, resolveCredential func(string) (string, bool)) ([]Projection, []SkipReason) {
	var projections []Projection
	var skips []SkipReason
	for _, entry := range reg.Providers() {
		provider, err := reg.LookupBinding(entry.ID)
		if err != nil {
			continue
		}
		ps, ss := projectProvider(provider, entry.Models, resolveCredential)
		projections = append(projections, ps...)
		skips = append(skips, ss...)
	}
	return projections, skips
}

// projectProvider evaluates a single provider and its catalog models.
func projectProvider(provider catalog.Provider, models []catalog.ModelDef, resolveCredential func(string) (string, bool)) ([]Projection, []SkipReason) {
	if !provider.SupportsDialect(catalog.DialectGrok) {
		return nil, []SkipReason{{ProviderID: provider.Name, Reason: "provider is not compatible with the Grok dialect"}}
	}

	// Require a non-empty RawLLM OpenAI endpoint.
	baseEndpoint := ""
	for _, cap := range provider.RawLLM {
		if cap.Protocol == catalog.RawLLMProtocolOpenAI && strings.TrimSpace(cap.BaseEndpoint) != "" {
			baseEndpoint = strings.TrimSpace(cap.BaseEndpoint)
			break
		}
	}
	if baseEndpoint == "" {
		return nil, []SkipReason{{ProviderID: provider.Name, Reason: "provider exposes no OpenAI-compatible raw protocol endpoint"}}
	}

	// Require a forge-managed credential resolver. Codex OAuth and others are
	// excluded here even if they advertise an OpenAI-shaped endpoint.
	if provider.Inference == nil || provider.Inference.CredentialResolver != "forge-managed" {
		return nil, []SkipReason{{ProviderID: provider.Name, Reason: "provider credential resolver is not forge-managed"}}
	}

	// Credential presence is resolved once per provider.
	_, credOK := resolveCredential(provider.Name)

	var projections []Projection
	var skips []SkipReason
	for _, model := range models {
		if model.ContextWindow <= 0 {
			skips = append(skips, SkipReason{
				ProviderID: provider.Name,
				ModelID:    model.ID,
				Reason:     fmt.Sprintf("model %q has no explicit context_window in catalog", model.ID),
			})
			continue
		}
		if !credOK {
			skips = append(skips, SkipReason{
				ProviderID: provider.Name,
				ModelID:    model.ID,
				Reason:     "no forge-managed credential resolved for provider",
			})
			continue
		}
		projections = append(projections, ProjectModel(provider.Name, baseEndpoint, model))
	}
	return projections, skips
}

// trimChatCompletionsSuffix strips exactly one terminal /chat/completions from
// url. URLs without that suffix are returned unchanged.
func trimChatCompletionsSuffix(url string) string {
	const suffix = "/chat/completions"
	if strings.HasSuffix(url, suffix) {
		return url[:len(url)-len(suffix)]
	}
	return url
}

// ProjectModel builds a Projection for a single eligible (provider, model).
// The baseEndpoint is the provider's raw OpenAI BaseEndpoint (which may carry
// a terminal /chat/completions path). The returned BaseURL strips that path
// so that the Grok chat_completions backend can append it without doubling.
func ProjectModel(providerID, baseEndpoint string, model catalog.ModelDef) Projection {
	id := ModelID(providerID, model.ID)
	return Projection{
		ID:                    id,
		Name:                  ModelName(providerID, model.DisplayName),
		Model:                 model.ID,
		BaseURL:               trimChatCompletionsSuffix(baseEndpoint),
		EnvKey:                EnvKey(providerID),
		APIBackend:            APIBackend,
		SupportsBackendSearch: false,
		ContextWindow:         model.ContextWindow,
		ProviderID:            providerID,
	}
}

// ModelID returns the stable Grok model id for a (provider, model) pair:
// forge-<provider-id>--<normalized-model-id>. Unsafe characters in the
// normalized model id are mapped to hyphens.
func ModelID(providerID, modelID string) string {
	return ModelIDPrefix + providerID + "--" + normalizeModelID(modelID)
}

var unsafeModelIDChars = regexp.MustCompile(`[^A-Za-z0-9_]`)

func normalizeModelID(modelID string) string {
	return unsafeModelIDChars.ReplaceAllString(modelID, "-")
}

// EnvKey returns the deterministic FORGE_GROK_<SCREAMING_PROVIDER>_API_KEY name
// for a provider. The provider id is upper-cased and any non
// identifier character is mapped to an underscore, yielding a legal
// environment variable name.
func EnvKey(providerID string) string {
	upper := strings.ToUpper(providerID)
	screaming := unsafeEnvKeyChars.ReplaceAllString(upper, "_")
	return "FORGE_GROK_" + screaming + "_API_KEY"
}

var unsafeEnvKeyChars = regexp.MustCompile(`[^A-Za-z0-9_]`)

// IsValidEnvKey reports whether name is a legal POSIX/Windows env var name.
func IsValidEnvKey(name string) bool {
	return validEnvKey.MatchString(name)
}

var validEnvKey = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// ModelName builds a readable display name from a provider id and a model
// display name, avoiding duplicated wording when the model display name
// already carries the provider prefix.
func ModelName(providerID, modelDisplayName string) string {
	providerName := providerFriendlyName(providerID)
	if modelDisplayName == "" {
		return providerName
	}
	// Avoid "Kimi Coding · Kimi K3" style duplication.
	if strings.HasPrefix(modelDisplayName, strings.Split(providerName, " ")[0]) {
		return modelDisplayName
	}
	return providerName + " · " + modelDisplayName
}

func providerFriendlyName(providerID string) string {
	if name, ok := friendlyProviderNames[providerID]; ok {
		return name
	}
	// Fallback: title-case the id segments.
	parts := strings.Split(providerID, "-")
	for i, p := range parts {
		if p == "" {
			continue
		}
		parts[i] = strings.ToUpper(p[:1]) + p[1:]
	}
	return strings.Join(parts, " ")
}

var friendlyProviderNames = map[string]string{
	"kimi-coding":     "Kimi Coding",
	"zhipu-coding":    "Zhipu Coding",
	"anthropic":       "Anthropic",
	"codex":           "Codex",
	"codex-spark":     "Codex Spark",
	"opencode-native": "OpenCode",
}
