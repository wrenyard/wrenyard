package cursor

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
	"unicode"
)

const (
	defaultAvailableModelsEndpoint = "https://api2.cursor.sh/aiserver.v1.AiService/AvailableModels"
	maxAvailabilityBodyBytes       = 2 << 20
	maxAvailabilityTimeout         = 3 * time.Second
	maxModelIDLength               = 120
)

const availableModelsRequestBody = `{"useModelParameters":true,"includeHiddenModels":true,"doNotUseMarkdown":true}`

// Stable availability statuses. Lookup of a missing id is unknown.
const (
	StatusAvailable = "available"
	StatusBlocked   = "blocked"
	StatusUnknown   = "unknown"
)

// Stable block reasons. These are policy outcomes, not raw upstream strings.
const (
	ReasonAdminBlocked    = "admin_blocked"
	ReasonConsentRequired = "consent_required"
	ReasonModelDisabled   = "model_disabled"
	ReasonUnsupported     = "unsupported"
)

var (
	errAvailabilityUnavailable = fmt.Errorf("cursor model availability is unavailable")
	errAvailabilityTimeout     = fmt.Errorf("cursor model availability timed out")
	errAvailabilityMalformed   = fmt.Errorf("cursor model availability is invalid")
	errAvailabilityAuth        = fmt.Errorf("cursor authentication is unavailable")
)

// HTTPClient is the injectable transport used by Reader.
type HTTPClient interface {
	Do(*http.Request) (*http.Response, error)
}

// Availability is the safe per-id projection of Cursor model access.
type Availability struct {
	Status string `json:"status"`
	Reason string `json:"reason,omitempty"`
}

// Reader performs one non-inference AvailableModels read. It has no
// persistent or global cache; each Availability call hits the transport.
type Reader struct {
	Client   HTTPClient
	Endpoint string
	Token    string
	Timeout  time.Duration
	Home     string
}

type availableModelsResponse struct {
	Models []availableModel `json:"models"`
}

type availableModel struct {
	Name                     string          `json:"name"`
	ServerModelName          string          `json:"serverModelName"`
	LegacySlugs              []string        `json:"legacySlugs"`
	IDAliases                []string        `json:"idAliases"`
	Variants                 json.RawMessage `json:"variants"`
	SupportsAgent            *bool           `json:"supportsAgent"`
	DegradationStatus        json.RawMessage `json:"degradationStatus"`
	ReasonForZdrConsentBlock string          `json:"reasonForZdrConsentBlock"`
}

// Availability returns the current per-id access map. A missing or
// malformed model list is an error (never authenticated => all available).
func (r Reader) Availability() (map[string]Availability, error) {
	token, err := r.resolvedToken()
	if err != nil {
		return nil, err
	}
	endpoint := strings.TrimSpace(r.Endpoint)
	if endpoint == "" {
		endpoint = defaultAvailableModelsEndpoint
	}
	timeout := r.Timeout
	if timeout <= 0 || timeout > maxAvailabilityTimeout {
		timeout = maxAvailabilityTimeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader([]byte(availableModelsRequestBody)))
	if err != nil {
		return nil, errAvailabilityUnavailable
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Connect-Protocol-Version", "1")
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := r.httpClient(timeout).Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, errAvailabilityTimeout
		}
		return nil, errAvailabilityUnavailable
	}
	defer resp.Body.Close()

	limited := io.LimitReader(resp.Body, maxAvailabilityBodyBytes+1)
	body, err := io.ReadAll(limited)
	if err != nil {
		if ctx.Err() != nil {
			return nil, errAvailabilityTimeout
		}
		return nil, errAvailabilityUnavailable
	}
	if len(body) > maxAvailabilityBodyBytes {
		return nil, errAvailabilityUnavailable
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, errAvailabilityUnavailable
	}

	var parsed availableModelsResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, errAvailabilityMalformed
	}
	if parsed.Models == nil {
		return nil, errAvailabilityMalformed
	}
	return projectAvailability(parsed.Models), nil
}

func (r Reader) resolvedToken() (string, error) {
	if tok := strings.TrimSpace(r.Token); tok != "" {
		return tok, nil
	}
	home := strings.TrimSpace(r.Home)
	if home == "" {
		var err error
		home, err = os.UserHomeDir()
		if err != nil || strings.TrimSpace(home) == "" {
			return "", errAvailabilityAuth
		}
	}
	tok, err := AccessToken(StatePath(home))
	if err != nil || strings.TrimSpace(tok) == "" {
		return "", errAvailabilityAuth
	}
	return strings.TrimSpace(tok), nil
}

func (r Reader) httpClient(timeout time.Duration) HTTPClient {
	if r.Client != nil {
		return r.Client
	}
	return &http.Client{Timeout: timeout}
}

func projectAvailability(models []availableModel) map[string]Availability {
	out := make(map[string]Availability)
	for _, model := range models {
		av := classifyModel(model)
		for _, id := range modelIDs(model) {
			if existing, ok := out[id]; ok {
				out[id] = mergeConservative(existing, av)
				continue
			}
			out[id] = av
		}
	}
	return out
}

func classifyModel(model availableModel) Availability {
	if reason := strings.TrimSpace(model.ReasonForZdrConsentBlock); reason != "" {
		mapped := ReasonConsentRequired
		if reason == "team_settings_blocked" {
			mapped = ReasonAdminBlocked
		}
		return Availability{Status: StatusBlocked, Reason: mapped}
	}
	if degradationDisabled(model.DegradationStatus) {
		return Availability{Status: StatusBlocked, Reason: ReasonModelDisabled}
	}
	if model.SupportsAgent != nil && !*model.SupportsAgent {
		return Availability{Status: StatusBlocked, Reason: ReasonUnsupported}
	}
	if model.SupportsAgent == nil {
		return Availability{Status: StatusUnknown}
	}
	return Availability{Status: StatusAvailable}
}

func degradationDisabled(raw json.RawMessage) bool {
	if len(bytes.TrimSpace(raw)) == 0 || string(raw) == "null" {
		return false
	}
	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		return asString == "DEGRADATION_STATUS_DISABLED"
	}
	// Connect JSON can encode protobuf enums by name or numeric value.
	return string(bytes.TrimSpace(raw)) == "2"
}

func modelIDs(model availableModel) []string {
	seen := make(map[string]struct{})
	var ids []string
	add := func(id string) {
		id, ok := safeModelID(id)
		if !ok {
			return
		}
		if _, exists := seen[id]; exists {
			return
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	add(model.Name)
	add(model.ServerModelName)
	for _, slug := range model.LegacySlugs {
		add(slug)
	}
	for _, alias := range model.IDAliases {
		add(alias)
	}
	for _, variant := range variantIDs(model.Variants) {
		add(variant)
	}
	return ids
}

func variantIDs(raw json.RawMessage) []string {
	if len(bytes.TrimSpace(raw)) == 0 || string(raw) == "null" {
		return nil
	}
	var asStrings []string
	if err := json.Unmarshal(raw, &asStrings); err == nil {
		return asStrings
	}
	var asObjects []struct {
		LegacySlug                  string `json:"legacySlug"`
		VariantStringRepresentation string `json:"variantStringRepresentation"`
	}
	if err := json.Unmarshal(raw, &asObjects); err == nil {
		var ids []string
		for _, obj := range asObjects {
			ids = append(ids, obj.LegacySlug, obj.VariantStringRepresentation)
		}
		return ids
	}
	return nil
}

func mergeConservative(existing, incoming Availability) Availability {
	rank := func(status string) int {
		switch status {
		case StatusBlocked:
			return 3
		case StatusUnknown:
			return 2
		case StatusAvailable:
			return 1
		default:
			return 2
		}
	}
	if rank(existing.Status) > rank(incoming.Status) {
		return existing
	}
	if rank(incoming.Status) > rank(existing.Status) {
		return incoming
	}
	if existing.Status == StatusBlocked && incoming.Status == StatusBlocked && existing.Reason != incoming.Reason {
		return Availability{Status: StatusUnknown}
	}
	if existing != incoming {
		return Availability{Status: StatusUnknown}
	}
	return existing
}

func safeModelID(id string) (string, bool) {
	if id == "" || len(id) > maxModelIDLength || strings.TrimSpace(id) != id {
		return "", false
	}
	for _, r := range id {
		if r < 32 || r == 127 || unicode.IsControl(r) {
			return "", false
		}
	}
	return id, true
}
