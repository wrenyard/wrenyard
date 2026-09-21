package cursor

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/clients/account"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/cursor"
	"net/http"
	"strings"
	"time"
)

type RawObservation = account.Observation

const cursorDashboardEndpoint = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage"

type Client struct {
	// StatePath is the path to Cursor Desktop's state.vscdb. Empty resolves
	// the standard per-platform path.
	StatePath string
	// Endpoint is the GetCurrentPeriodUsage URL. Empty uses the default.
	Endpoint string
	// HTTPClient is the HTTP client used for the dashboard request. Nil uses
	// http.DefaultClient.
	HTTPClient *http.Client
	// Now returns the current time for FetchedAt. Nil uses time.Now.
	Now func() time.Time
}

func (p Client) ReadUsage(ctx context.Context) (RawObservation, error) {
	now := time.Now()
	if p.Now != nil {
		now = p.Now()
	}

	statePath := p.StatePath
	if statePath == "" {
		statePath = cursor.StatePath("")
	}
	token, err := cursor.AccessToken(statePath)
	if err != nil {
		return RawObservation{}, err
	}
	if strings.TrimSpace(token) == "" {
		return RawObservation{}, fmt.Errorf("cursor: no access token found in %s", statePath)
	}

	endpoint := p.Endpoint
	if endpoint == "" {
		endpoint = cursorDashboardEndpoint
	}
	client := p.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader([]byte("{}")))
	if err != nil {
		return RawObservation{}, fmt.Errorf("cursor: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Connect-Protocol-Version", "1")
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := client.Do(req)
	if err != nil {
		return RawObservation{}, fmt.Errorf("cursor: dashboard request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return RawObservation{}, fmt.Errorf("cursor: dashboard rejected credentials (status %d)", resp.StatusCode)
	}
	if resp.StatusCode != http.StatusOK {
		return RawObservation{}, fmt.Errorf("cursor: dashboard returned status %d", resp.StatusCode)
	}

	var raw json.RawMessage
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return RawObservation{}, err
	}
	return RawObservation{Source: "cursor-dashboard", FetchedAt: now, Data: raw}, nil
}
