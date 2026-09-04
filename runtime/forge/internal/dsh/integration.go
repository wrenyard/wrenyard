// Package dsh contains the small native adapter that projects Wrenyard's
// daemon-owned Model Gateway into DSH. It deliberately owns no provider
// endpoints, credentials, or model catalog.
package dsh

import (
	"fmt"
	"sort"
	"strings"
)

type APIType string

const (
	APITypeOpenAICompletions   APIType    = "openai-completions"
	APITypeDeepSeekNative      APIType    = "deepseek-official"
	PermissionReadOnly         Permission = "read-only"
	PermissionWorkspaceWrite   Permission = "workspace-write"
	PermissionDangerFullAccess Permission = "danger-full-access"
	GatewayProviderID                     = "llm-pi-ai.wrenyard"
	GatewayAPIKeyEnv                      = "WRENYARD_GATEWAY_TOKEN"
)

type Permission string

func (p Permission) String() string { return string(p) }

type Model struct {
	ID            string
	Label         string
	ContextWindow int
	MaxTokens     int
	Reasoning     bool
}

type Provider struct {
	ID        string
	APIType   APIType
	APIKeyEnv string
	BaseURL   string
	Models    []Model
}

func (p Provider) EnvName() string { return p.APIKeyEnv }
func (p Provider) ModelIDs() []string {
	ids := make([]string, 0, len(p.Models))
	for _, model := range p.Models {
		ids = append(ids, model.ID)
	}
	sort.Strings(ids)
	return ids
}

// GatewayProvider is the only DSH provider Wrenyard injects. Its model ids
// remain provider/model so the daemon Gateway performs unambiguous routing.
func GatewayProvider(baseURL string, models []Model) Provider {
	return Provider{ID: GatewayProviderID, APIType: APITypeOpenAICompletions, APIKeyEnv: GatewayAPIKeyEnv, BaseURL: NormalizeBaseURL(baseURL), Models: append([]Model(nil), models...)}
}

func RouteKey(provider Provider) string { return strings.TrimPrefix(provider.ID, "llm-pi-ai.") }

type TypedCredential struct {
	Token string
}
type ProviderProjection struct {
	Provider Provider
	Env      map[string]string
}

func ValidateCredential(provider Provider, credential TypedCredential) error {
	if provider.ID != GatewayProviderID {
		return fmt.Errorf("dsh: unsupported provider %q", provider.ID)
	}
	if !isSensitiveEnvName(provider.APIKeyEnv) {
		return fmt.Errorf("dsh: provider %s env %q must end in API_KEY, SECRET, or TOKEN", provider.ID, provider.APIKeyEnv)
	}
	if strings.TrimSpace(credential.Token) == "" {
		return fmt.Errorf("dsh: credential for %s must carry a token", provider.ID)
	}
	return nil
}

func ProjectProvider(provider Provider, credential TypedCredential) ProviderProjection {
	projection := ProviderProjection{Provider: provider, Env: map[string]string{}}
	if strings.TrimSpace(credential.Token) != "" {
		projection.Env[provider.APIKeyEnv] = credential.Token
	}
	return projection
}

func LaunchEnv(provider Provider, credential TypedCredential, extras []string) []string {
	out := append([]string(nil), extras...)
	for name, value := range ProjectProvider(provider, credential).Env {
		out = append(out, name+"="+value)
	}
	sort.Strings(out)
	return out
}

func isSensitiveEnvName(name string) bool {
	return strings.HasSuffix(name, "API_KEY") || strings.HasSuffix(name, "SECRET") || strings.HasSuffix(name, "TOKEN")
}
func NormalizeBaseURL(raw string) string { return strings.TrimRight(raw, "/") }

type RuntimePatchAssets struct {
	Version   string
	PatchPath string
	Plugin    PluginAsset
}
type PluginAsset struct {
	Name     string
	Filename string
	Source   string
}

func DefaultRuntimePatchAssets() RuntimePatchAssets {
	return RuntimePatchAssets{Version: ProtocolVersion, PatchPath: "patch.yaml", Plugin: PluginAsset{Name: PluginName, Filename: PluginFilename, Source: PluginSource}}
}
