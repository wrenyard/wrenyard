// Package dsh provides typed, cycle-free projection primitives for the Forge
// DSH client integration: DSH is a distinct Forge dialect shipped through the
// stable fdsh executable, and Forge background agents launch it with a hidden
// --forge-agent flag and an isolated per-run DSH_HOME. This package models
// provider/model projection inputs, launch-time credential env outputs,
// permission values, runtime patch assets and MCP capability rows. It never
// owns persistent credentials: values are supplied at launch time and files
// generated here only ever contain env names and !!js process.env refs.
package dsh

import (
	"fmt"
	"sort"
	"strings"
)

// APIType is the upstream API dialect a provider projection speaks.
type APIType string

const (
	// APITypeOpenAICompletions is the openai-completions dialect used by all
	// injected llm-pi-ai providers.
	APITypeOpenAICompletions APIType = "openai-completions"
	// APITypeDeepSeekNative is the native deepseek-official dialect that fdsh
	// keeps out of the box and that injected patches never re-emit.
	APITypeDeepSeekNative APIType = "deepseek-official"
)

// Permission is a launch-time workspace permission env value.
type Permission string

const (
	PermissionReadOnly         Permission = "read-only"
	PermissionWorkspaceWrite   Permission = "workspace-write"
	PermissionDangerFullAccess Permission = "danger-full-access"
)

// String implements fmt.Stringer.
func (p Permission) String() string { return string(p) }

// Model is a single provider model projection.
type Model struct {
	ID            string // stable machine id used in patches and route selection
	Label         string // human-facing label
	ContextWindow int    // advertised context capacity; zero uses DSH fallback
	MaxTokens     int    // advertised output cap; zero uses DSH fallback
	Reasoning     bool   // expose off/high reasoning effort selection
}

// Provider is a typed provider projection. It carries shape data only; the
// credential value for APIKeyEnv is supplied by the caller at launch time.
// Headers maps extra HTTP header names to the child env names holding their
// launch-time values; it never holds a literal value. Authorization is
// handled solely by APIKeyEnv and is never carried in Headers.
type Provider struct {
	ID        string
	APIType   APIType
	APIKeyEnv string            // child env name; must end in API_KEY or SECRET
	BaseURL   string            // normalized base URL (no trailing slash)
	Models    []Model           // deterministic caller order; preserved by renderers
	Headers   map[string]string // header name → child env name reference
}

// EnvName returns the launch-time credential env var name for p.
func (p Provider) EnvName() string { return p.APIKeyEnv }

// ModelIDs returns the stable ids of all models projected by p, sorted.
func (p Provider) ModelIDs() []string {
	ids := make([]string, 0, len(p.Models))
	for _, m := range p.Models {
		ids = append(ids, m.ID)
	}
	sort.Strings(ids)
	return ids
}

// InjectedProviders are the public llm-pi-ai providers mounted by the rc.6
// patch: kimi-coding and zhipu-coding. This order mirrors the DSH-compatible
// subset of providers.Modules(). They complement (never replace) the native
// deepseek-official V4 Flash/Pro routes that fdsh keeps out of the box. The
// catalog mirrors the real Forge ProviderModule data so rendered routes and
// DSH_MODEL selections match production endpoints.
var InjectedProviders = []Provider{
	{
		ID:        "llm-pi-ai.kimi-coding",
		APIType:   APITypeOpenAICompletions,
		APIKeyEnv: "FORGE_DSH_KIMI_CODING_API_KEY",
		BaseURL:   "https://api.kimi.com/coding/v1",
		Models: []Model{
			{ID: "k3", Label: "Kimi K3", ContextWindow: 1048576, MaxTokens: 32768},
			{ID: "k3[1m]", Label: "Kimi K3 1M Context", ContextWindow: 1048576, MaxTokens: 32768},
		},
	},
	{
		ID:        "llm-pi-ai.zhipu-coding",
		APIType:   APITypeOpenAICompletions,
		APIKeyEnv: "FORGE_DSH_ZHIPU_CODING_API_KEY",
		BaseURL:   "https://open.bigmodel.cn/api/coding/paas/v4",
		Models: []Model{
			{ID: "glm-5.3", Label: "GLM-5.3", ContextWindow: 1048576, MaxTokens: 32768},
		},
	},
}

// ProviderByID returns the injected provider with the given id, or ok=false.
func ProviderByID(id string) (Provider, bool) {
	for _, p := range InjectedProviders {
		if p.ID == id {
			return p, true
		}
	}
	return Provider{}, false
}

// RouteKey returns the canonical provider route key used as the loader overlay
// providers dict key: the provider id without the llm-pi-ai. prefix.
func RouteKey(p Provider) string {
	return strings.TrimPrefix(p.ID, "llm-pi-ai.")
}

// TypedCredential is the launch-time credential for a provider: the bearer
// token plus HTTP context headers. Values are transient and must only reach
// the dsh child process through its environment; generated files carry env
// name references only.
type TypedCredential struct {
	Token   string
	Headers map[string]string
}

// Credentials maps a provider id to its launch-time typed credential. Values
// are transient and must never be persisted by callers.
type Credentials map[string]TypedCredential

// ValidateCredentials ensures every provided credential references a known
// injected provider, carries a token or at least one non-Authorization
// context header, and uses a DSH-scrubbed env name (suffix API_KEY or
// SECRET). A nil or empty set is valid: routes stay visible without
// credentials.
func ValidateCredentials(creds Credentials) error {
	for id, cred := range creds {
		p, ok := ProviderByID(id)
		if !ok {
			return fmt.Errorf("dsh: unknown provider %q", id)
		}
		if !isSensitiveEnvName(p.APIKeyEnv) {
			return fmt.Errorf("dsh: provider %s env %q must end in API_KEY or SECRET", id, p.APIKeyEnv)
		}
		if strings.TrimSpace(cred.Token) == "" && !hasNonAuthHeader(cred.Headers) {
			return fmt.Errorf("dsh: credential for %s must carry a token or a context header", id)
		}
	}
	return nil
}

// ProviderProjection is the secret-free result of projecting a provider with
// its launch-time typed credential. Provider carries only env references
// (APIKeyEnv plus Headers mapping header names to child env names); Env holds
// the child-only credential values (token and non-Authorization header
// values). Generated files only ever contain the env references.
type ProviderProjection struct {
	Provider Provider
	Env      map[string]string
}

// ProjectProvider projects a provider with its typed credential. The returned
// provider keeps the route visible even when the credential is missing or
// empty, in which case Env stays empty. Authorization is handled solely by
// APIKeyEnv and is filtered from the projected header references.
func ProjectProvider(p Provider, cred TypedCredential) ProviderProjection {
	proj := ProviderProjection{Provider: p, Env: map[string]string{}}
	if strings.TrimSpace(cred.Token) != "" {
		proj.Env[p.APIKeyEnv] = cred.Token
	}
	headerRefs := make(map[string]string)
	for name, value := range cred.Headers {
		if strings.EqualFold(name, "Authorization") {
			continue
		}
		if strings.TrimSpace(value) == "" {
			continue
		}
		envName := headerEnvName(p, name)
		headerRefs[name] = envName
		proj.Env[envName] = value
	}
	if len(headerRefs) > 0 {
		cp := p
		cp.Headers = headerRefs
		proj.Provider = cp
	}
	return proj
}

// ProjectProviders projects every injected provider with its typed credential,
// preserving InjectedProviders order. A provider without a credential keeps its
// route visible with no child env values.
func ProjectProviders(creds Credentials) []ProviderProjection {
	out := make([]ProviderProjection, 0, len(InjectedProviders))
	for _, p := range InjectedProviders {
		out = append(out, ProjectProvider(p, creds[p.ID]))
	}
	return out
}

// headerEnvName derives a stable child env name for a provider context header:
// FORGE_DSH_<PROVIDER>_<HEADER>_SECRET. The canonical provider identity and
// the normalized header identity are separated by exactly one underscore, so
// Zhipu X-Domain becomes FORGE_DSH_ZHIPU_CODING_X_DOMAIN_SECRET.
func headerEnvName(p Provider, header string) string {
	var b strings.Builder
	b.WriteString("FORGE_DSH_")
	b.WriteString(canonicalProviderKey(p.ID))
	b.WriteByte('_')
	for _, r := range strings.ToUpper(header) {
		if (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		} else {
			b.WriteByte('_')
		}
	}
	b.WriteString("_SECRET")
	return b.String()
}

// canonicalProviderKey is the canonical all-caps provider identity used inside
// generated env names (e.g. llm-pi-ai.zhipu-coding → ZHIPU_CODING).
func canonicalProviderKey(id string) string {
	key := strings.TrimPrefix(id, "llm-pi-ai.")
	var b strings.Builder
	for _, r := range strings.ToUpper(key) {
		if (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		} else {
			b.WriteByte('_')
		}
	}
	return b.String()
}

// LaunchEnv builds the deterministic, sorted child environment for a DSH
// launch from transient typed credentials plus passthrough extras. It returns
// env NAME=VALUE pairs only; generated files never contain these values.
func LaunchEnv(creds Credentials, extras []string) []string {
	env := make([]string, 0, len(creds)+len(extras))
	for _, proj := range ProjectProviders(creds) {
		for name, value := range proj.Env {
			env = append(env, name+"="+value)
		}
	}
	env = append(env, extras...)
	sort.Strings(env)
	return env
}

func hasNonAuthHeader(headers map[string]string) bool {
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

func isSensitiveEnvName(name string) bool {
	return strings.HasSuffix(name, "API_KEY") || strings.HasSuffix(name, "SECRET")
}

// NormalizeBaseURL strips trailing slashes so generated patches are
// deterministic regardless of input formatting.
func NormalizeBaseURL(raw string) string {
	return strings.TrimRight(raw, "/")
}

// RuntimePatchAssets describes the deterministic artifacts a DSH launch
// renders into the isolated per-run DSH_HOME.
type RuntimePatchAssets struct {
	Version   string      // DSH protocol version pinned by the patch
	PatchPath string      // path (relative to DSH_HOME) of the rendered patch
	Plugin    PluginAsset // embedded ESM bridge plugin descriptor
}

// PluginAsset describes the embedded ESM bridge plugin.
type PluginAsset struct {
	Name     string
	Filename string
	Source   string
}

// DefaultRuntimePatchAssets returns the rc.6 runtime patch asset descriptor.
func DefaultRuntimePatchAssets() RuntimePatchAssets {
	return RuntimePatchAssets{
		Version:   ProtocolVersion,
		PatchPath: "patch.yaml",
		Plugin: PluginAsset{
			Name:     PluginName,
			Filename: PluginFilename,
			Source:   PluginSource,
		},
	}
}
