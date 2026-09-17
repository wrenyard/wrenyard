package driver

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/protocol"
)

// responseTPSSamplingContract labels every NEW speed sample with the unified
// approximate contract: a fixed cl100k_base tokenizer over only the generation
// content that was actually observed streaming, divided by exactly its own
// first-to-last delta window. Official usage and billing are never replaced by
// these counts, and samples already persisted under an older contract are
// never relabeled.
const responseTPSSamplingContract = tokenizerTPSSamplingContract

type responseTPSSample struct {
	ResponseID     string
	Model          string
	OutputTokens   int64
	FirstTokenAtMS int64
	CompletedAtMS  int64
}

type responseTPSResponse struct {
	id         string
	model      string
	gen        tokenizerGeneration
	overlapped bool
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

// responseTPSBlockKey names one streamed content block: the delta type plus
// the block index (the tool_use position for streamed tool arguments). The
// streams of one block concatenate before encoding, so the count never
// depends on how a provider splits its deltas.
func responseTPSBlockKey(record, event map[string]any, deltaType string) string {
	for _, source := range []map[string]any{event, record} {
		if index, ok := source["index"].(float64); ok {
			return deltaType + "/" + strconv.FormatInt(int64(index), 10)
		}
	}
	return deltaType
}

// observeContentDelta accumulates one NON-EMPTY streamed delta of the active
// response into its content block, stamped with the sampler's monotonic anchor
// at arrival. Text, visible thinking, and streamed tool arguments are observed
// generation; tool output, summaries, and records that carry no text never
// pass through here.
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
	s.active.gen.observe(responseTPSBlockKey(record, event, deltaType), value, s.timestamp(s.now()))
}

// observeMessageStop closes the active response's observed generation into one
// tokenizer_v1 sample. The window runs from the response's first to its last
// non-empty delta and the token count comes from the fixed tokenizer, so
// neither the completion's own latency nor any usage figure is part of the
// measurement. A window that never spanned the minimum observable interval (a
// buffered or collapsed stream) is skipped without poisoning the sampler.
func (s *responseTPSSampler) observeMessageStop(record, event map[string]any) {
	if !s.responseMatches(record, event) {
		return
	}
	active := s.active
	s.active = nil
	s.seen[active.id] = true
	if active.overlapped {
		return
	}
	tokens, first, last, ok := active.gen.measure()
	if !ok {
		return
	}
	s.samples = append(s.samples, responseTPSSample{
		ResponseID: active.id, Model: active.model, OutputTokens: tokens,
		FirstTokenAtMS: first, CompletedAtMS: last,
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
