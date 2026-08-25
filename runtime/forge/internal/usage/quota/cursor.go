package quota

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/cursor"
)

// cursorDashboardEndpoint is the default GetCurrentPeriodUsage endpoint.
const cursorDashboardEndpoint = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage"

// cursorWindowMinutes is the length of a Cursor monthly billing cycle.
const cursorWindowMinutes = 43200

// CursorProvider resolves Cursor Desktop quota by reading the local
// state.vscdb access token and querying the DashboardService usage API.
// It is fail-closed: every database/token/network/HTTP/auth/malformed/no-window
// failure returns a sanitized error that never contains the access token.
type CursorProvider struct {
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

func (p CursorProvider) Name() string { return "cursor" }

// Fetch reads the access token and reports the current billing period usage.
func (p CursorProvider) Fetch(ctx context.Context) (Quota, error) {
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
		return Quota{}, err
	}
	if strings.TrimSpace(token) == "" {
		return Quota{}, fmt.Errorf("cursor: no access token found in %s", statePath)
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
		return Quota{}, fmt.Errorf("cursor: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Connect-Protocol-Version", "1")
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := client.Do(req)
	if err != nil {
		return Quota{}, fmt.Errorf("cursor: dashboard request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return Quota{}, fmt.Errorf("cursor: dashboard rejected credentials (status %d)", resp.StatusCode)
	}
	if resp.StatusCode != http.StatusOK {
		return Quota{}, fmt.Errorf("cursor: dashboard returned status %d", resp.StatusCode)
	}

	var usage cursorUsageResponse
	if err := json.NewDecoder(resp.Body).Decode(&usage); err != nil {
		return Quota{}, fmt.Errorf("cursor: malformed dashboard response: %w", err)
	}

	windows := cursorWindows(usage)
	if len(windows) == 0 {
		return Quota{}, fmt.Errorf("cursor: no usage windows available")
	}

	return Quota{
		Provider:  "cursor",
		Source:    "cursor-dashboard",
		Label:     "Cursor Team",
		FetchedAt: now,
		Windows:   windows,
	}, nil
}

type cursorUsageResponse struct {
	BillingCycleStart string           `json:"billingCycleStart"`
	BillingCycleEnd   string           `json:"billingCycleEnd"`
	PlanUsage         *cursorPlanUsage `json:"planUsage"`
}

type cursorPlanUsage struct {
	AutoPercentUsed  *float64 `json:"autoPercentUsed"`
	APIPercentUsed   *float64 `json:"apiPercentUsed"`
	TotalPercentUsed *float64 `json:"totalPercentUsed"`
}

// cursorWindows builds the monthly quota windows. When Cursor or Other usage
// is present, both windows are emitted sharing the same reset time and window
// length; otherwise a single Total fallback window is used.
func cursorWindows(resp cursorUsageResponse) []Window {
	var resetsAt *time.Time
	if t, ok := parseCursorTime(resp.BillingCycleEnd); ok {
		resetsAt = &t
	}
	if resp.PlanUsage == nil {
		return nil
	}
	add := func(name string, pct *float64, out []Window) []Window {
		if pct == nil {
			return out
		}
		return append(out, Window{
			Name:          name,
			Pct:           clampPct(*pct),
			ResetsAt:      resetsAt,
			WindowMinutes: cursorWindowMinutes,
		})
	}

	if resp.PlanUsage.AutoPercentUsed != nil || resp.PlanUsage.APIPercentUsed != nil {
		out := add("Cursor", resp.PlanUsage.AutoPercentUsed, nil)
		out = add("Other", resp.PlanUsage.APIPercentUsed, out)
		return out
	}
	return add("Total", resp.PlanUsage.TotalPercentUsed, nil)
}

// parseCursorTime accepts RFC3339 timestamps and unix seconds/millis.
func parseCursorTime(raw string) (time.Time, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}, false
	}
	for _, layout := range []string{time.RFC3339, "2006-01-02T15:04:05.999999999Z07:00", "2006-01-02"} {
		if t, err := time.Parse(layout, raw); err == nil {
			return t, true
		}
	}
	if f, err := strconv.ParseFloat(raw, 64); err == nil {
		if f > 1e11 {
			return time.UnixMilli(int64(f)), true
		}
		sec := int64(f)
		nanos := int64((f - float64(sec)) * 1e9)
		return time.Unix(sec, nanos), true
	}
	return time.Time{}, false
}
