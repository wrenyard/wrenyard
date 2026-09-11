package driver

import (
	"encoding/json"
	"math"
	"strings"
	"time"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/protocol"
)

const responseTPSSamplingContract = "response_v1"

type responseTPSSample struct {
	ResponseID     string
	Model          string
	OutputTokens   int64
	FirstTokenAtMS int64
	CompletedAtMS  int64
}

type responseTPSResponse struct {
	id             string
	model          string
	firstTokenAtMS int64
	started        bool
	usageSeen      bool
	usageValid     bool
	outputTokens   int64
	overlapped     bool
}

// responseTPSSampler consumes only the partial stream protocol. Full-message
// transcripts remain the source of normalized content and legacy accounting.
type responseTPSSampler struct {
	now          func() time.Time
	anchor       time.Time
	anchorMS     int64
	anchored     bool
	active       *responseTPSResponse
	seen         map[string]bool
	samples      []responseTPSSample
	terminalSeen bool
	terminalOK   bool
}

func responseTPSClientFamily(family string) bool {
	family = strings.ToLower(strings.TrimSpace(family))
	return family == "codebuddy" || family == "claude"
}

func (t *TranscriptTee) attachResponseTPSSamples(event *protocol.Event) {
	if event == nil || event.Type != "turn_usage" || event.Data == nil || t.responseTPSampler == nil || !t.responseTPSampler.terminalSeen || !t.responseTPSampler.terminalOK {
		return
	}
	t.responseTPSampler.takeSamples(event.Data)
}

func newResponseTPSSampler(now func() time.Time) responseTPSSampler {
	if now == nil {
		now = time.Now
	}
	return responseTPSSampler{now: now, seen: make(map[string]bool)}
}

func (s *responseTPSSampler) timestamp(now time.Time) int64 {
	if !s.anchored {
		s.anchor = now
		s.anchorMS = now.UnixMilli()
		s.anchored = true
		return s.anchorMS
	}
	delta := now.Sub(s.anchor)
	if delta < 0 {
		delta = 0
	}
	return s.anchorMS + delta.Milliseconds()
}

func (s *responseTPSSampler) invalidateActive() {
	if s.active != nil && s.active.id != "" {
		s.seen[s.active.id] = true
	}
	s.active = nil
}

func (s *responseTPSSampler) observe(line []byte) {
	var record map[string]any
	if json.Unmarshal(line, &record) != nil {
		return
	}
	if parent, ok := record["parent_tool_use_id"].(string); ok && strings.TrimSpace(parent) != "" {
		return
	}
	typ, _ := record["type"].(string)
	event, _ := record["event"].(map[string]any)
	if typ == "stream_event" || typ == "" {
		typ, _ = event["type"].(string)
	}

	if typ == "result" {
		s.terminalOK = !s.terminalSeen && !hasNormalizedFailureField(record) && record["is_error"] != true
		s.terminalSeen = true
		s.invalidateActive()
		return
	}
	if typ == "system" && record["subtype"] == "api_retry" {
		s.invalidateActive()
		return
	}
	switch typ {
	case "message_start":
		s.observeMessageStart(record, event)
	case "content_block_delta":
		s.observeContentDelta(record, event)
	case "message_delta":
		s.observeMessageDelta(record, event)
	case "message_stop":
		s.observeMessageStop(record, event)
	case "error", "message_error", "failed", "cancelled", "canceled", "retry", "retried":
		s.invalidateActive()
	}
}

func (s *responseTPSSampler) observeMessageStart(record, event map[string]any) {
	overlapped := s.active != nil
	if s.active != nil {
		s.invalidateActive()
	}
	message, _ := event["message"].(map[string]any)
	if message == nil {
		message, _ = record["message"].(map[string]any)
	}
	id, _ := message["id"].(string)
	model, _ := message["model"].(string)
	id = strings.TrimSpace(id)
	model = strings.TrimSpace(model)
	if id == "" || model == "" || s.seen[id] {
		return
	}
	s.active = &responseTPSResponse{id: id, model: model, overlapped: overlapped}
}

func responseTPSRecordID(record, event map[string]any) string {
	for _, key := range []string{"response_id", "message_id"} {
		if value, ok := record[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
		if value, ok := event[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func (s *responseTPSSampler) responseMatches(record, event map[string]any) bool {
	if s.active == nil {
		return false
	}
	if id := responseTPSRecordID(record, event); id != "" && id != s.active.id {
		s.invalidateActive()
		return false
	}
	return true
}

func (s *responseTPSSampler) observeContentDelta(record, event map[string]any) {
	if !s.responseMatches(record, event) || s.active.overlapped {
		return
	}
	delta, _ := event["delta"].(map[string]any)
	if delta == nil {
		delta, _ = record["delta"].(map[string]any)
	}
	deltaType, _ := delta["type"].(string)
	var value string
	switch deltaType {
	case "text_delta":
		value, _ = delta["text"].(string)
	case "thinking_delta":
		value, _ = delta["thinking"].(string)
	case "input_json_delta":
		value, _ = delta["partial_json"].(string)
	}
	if value == "" {
		return
	}
	if !s.active.started {
		s.active.started = true
		s.active.firstTokenAtMS = s.timestamp(s.now())
	}
}

func (s *responseTPSSampler) observeMessageDelta(record, event map[string]any) {
	if !s.responseMatches(record, event) || s.active.overlapped {
		return
	}
	usage, _ := event["usage"].(map[string]any)
	if usage == nil {
		usage, _ = record["usage"].(map[string]any)
	}
	if usage == nil {
		return
	}
	raw, present := usage["output_tokens"]
	if !present {
		return
	}
	s.active.usageSeen = true
	tokens, ok := safeResponseOutputTokens(raw)
	s.active.usageValid = ok
	if ok {
		s.active.outputTokens = tokens
	}
}

func (s *responseTPSSampler) observeMessageStop(record, event map[string]any) {
	if !s.responseMatches(record, event) {
		return
	}
	active := s.active
	s.active = nil
	s.seen[active.id] = true
	if active.overlapped || !active.started || !active.usageSeen || !active.usageValid {
		return
	}
	completedAtMS := s.timestamp(s.now())
	if completedAtMS <= active.firstTokenAtMS {
		return
	}
	s.samples = append(s.samples, responseTPSSample{
		ResponseID: active.id, Model: active.model, OutputTokens: active.outputTokens,
		FirstTokenAtMS: active.firstTokenAtMS, CompletedAtMS: completedAtMS,
	})
}

func safeResponseOutputTokens(raw any) (int64, bool) {
	switch value := raw.(type) {
	case json.Number:
		parsed, err := value.Int64()
		return parsed, err == nil && parsed >= 0 && parsed <= 1<<53-1
	case float64:
		if value < 0 || value != math.Trunc(value) || value > float64(1<<53-1) {
			return 0, false
		}
		return int64(value), true
	case int:
		return int64(value), value >= 0 && uint64(value) <= 1<<53-1
	case int64:
		return value, value >= 0 && value <= 1<<53-1
	default:
		return 0, false
	}
}

func (s *responseTPSSampler) takeSamples(data map[string]any) {
	if len(s.samples) == 0 || data == nil {
		return
	}
	data["tps_sampling_contract"] = responseTPSSamplingContract
	payload := make([]any, 0, len(s.samples))
	for _, sample := range s.samples {
		payload = append(payload, map[string]any{
			"response_id": sample.ResponseID, "model": sample.Model,
			"output_tokens":     sample.OutputTokens,
			"first_token_at_ms": sample.FirstTokenAtMS,
			"completed_at_ms":   sample.CompletedAtMS,
		})
	}
	data["tps_samples"] = payload
	s.samples = nil
}
