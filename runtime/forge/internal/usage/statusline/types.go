package statusline

import (
	"context"
	"time"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/usage/quota"
)

const (
	Red       = "\033[91m"
	Green     = "\033[92m"
	Yellow    = "\033[93m"
	DimYellow = "\033[2;93m"
	Reset     = "\033[0m"
)

type Input struct {
	SessionID     string `json:"session_id"`
	Transcript    string `json:"transcript_path"`
	Client        any    `json:"client"`
	Model         Model  `json:"model"`
	ProviderID    string `json:"provider_id,omitempty"`
	ContextWindow any    `json:"context_window"`
}

type Model struct {
	ID          string `json:"id"`
	DisplayName string `json:"display_name"`
	Provider    string `json:"provider,omitempty"`
	ProviderID  string `json:"provider_id,omitempty"`
}

type Profile struct {
	Name           string
	Client         string
	Provider       string
	Segments       []string
	QuotaProvider  string
	Billing        string
	ModelOverrides map[string]string
	MaxWidth       int
}

type Context struct {
	Context       context.Context
	QuotaContext  context.Context
	Input         Input
	Profile       Profile
	Billing       Billing
	QuotaProvider quota.Provider
	Home          string

	// StatuslineTTL is the configured statusline cache TTL; zero means default 120s.
	StatuslineTTL time.Duration

	// QuotaDisplayLength controls quota/usage window density. Empty means full.
	QuotaDisplayLength QuotaDisplayLength
}

type Segment interface {
	Render(Context) (string, error)
}
