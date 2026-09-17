package driver

import (
	"encoding/json"
	"strconv"
	"strings"
)

// Notification translation from the native app-server schema into the
// exec-shaped records normalize.go's codexNormalizer already understands:
//
//	thread/started                      -> thread.started
//	turn/started                        -> turn id capture only
//	item/started                        -> item.started  (tool items only)
//	item/completed                      -> item.completed
//	item/agentMessage/delta             -> generation window accumulation
//	item/reasoning/summaryTextDelta     -> generation window accumulation
//	item/reasoning/textDelta            -> generation window accumulation
//	rawResponse/completed               -> response usage + turn usage
//	thread/tokenUsage/updated           -> resumed-turn usage (baseline delta)
//	turn/completed                      -> turn.completed (status-aware)
//	error                               -> turn.failed when not retryable
//
// Codex 0.148 has no turn/failed notification: a failed or interrupted turn
// arrives as turn/completed with a non-completed turn status.
// Notifications belonging to another thread or turn are ignored entirely so a
// resumed session's historical replay cannot corrupt current-turn accounting.

// handleNotification translates one server notification. It is a no-op for
// foreign threads and turns.
func (b *codexAppServerBridge) handleNotification(msg codexAppServerMessage) {
	var params map[string]any
	if len(msg.Params) > 0 {
		_ = json.Unmarshal(msg.Params, &params)
	}
	if params == nil {
		params = map[string]any{}
	}
	switch msg.Method {
	case "thread/started":
		b.handleThreadStarted(params)
	case "turn/started":
		b.handleTurnStarted(params)
	case "item/started":
		b.handleItemStarted(params)
	case "item/completed":
		b.handleItemCompleted(params)
	case "item/agentMessage/delta":
		b.handleDelta(params, codexDeltaChannelText)
	case "item/reasoning/summaryTextDelta":
		b.handleDelta(params, codexDeltaChannelSummary)
	case "item/reasoning/textDelta":
		b.handleDelta(params, codexDeltaChannelRaw)
	case "rawResponse/completed":
		b.handleRawResponseCompleted(params)
	case "thread/tokenUsage/updated":
		// Only a resumed thread uses this path; a fresh run's raw sampling is
		// unaffected and never sees a tokenUsage notification.
		b.handleTokenUsageUpdated(params)
	case "turn/completed":
		b.handleTurnCompleted(params)
	case "error":
		b.handleErrorNotification(params)
	default:
		// Unknown notifications carry no normalized meaning for Forge.
	}
}

// withinTurn reports whether a notification belongs to the active thread and
// turn. An empty identity on either side is treated as active so a lenient
// server (or a resumed thread replay) still produces content.
func (b *codexAppServerBridge) withinTurn(params map[string]any) bool {
	if thread := codexThreadIdentity(params); thread != "" && b.threadID != "" && thread != b.threadID {
		return false
	}
	if turn := codexTurnIdentity(params); turn != "" && b.turnID != "" && turn != b.turnID {
		return false
	}
	return true
}

func (b *codexAppServerBridge) handleThreadStarted(params map[string]any) {
	if thread := codexThreadIdentity(params); thread != "" {
		b.threadID = thread
	}
}

// handleTurnStarted captures the active turn id. turn/started carries it under
// params.turn.id, and it is required for a later turn/interrupt.
func (b *codexAppServerBridge) handleTurnStarted(params map[string]any) {
	if !b.withinTurn(params) {
		return
	}
	if turn := codexTurnIdentity(params); turn != "" {
		b.turnID = turn
	}
}

func (b *codexAppServerBridge) handleItemStarted(params map[string]any) {
	if !b.withinTurn(params) {
		return
	}
	item, _ := params["item"].(map[string]any)
	if item == nil {
		return
	}
	execItem := translateAppServerItem(item)

	// item.started is only emitted for in-flight tool calls. file_change is
	// atomic and agent messages have no started boundary.
	if codexItemStartedToolCall(execItem) == nil {
		return
	}
	b.writeRecord(map[string]any{"type": "item.started", "item": execItem})
}

func (b *codexAppServerBridge) handleItemCompleted(params map[string]any) {
	if !b.withinTurn(params) {
		return
	}
	item, _ := params["item"].(map[string]any)
	if item == nil {
		return
	}
	execItem := translateAppServerItem(item)

	if execItem["type"] == "agent_message" {
		if text := codexAgentMessageText(execItem); text != "" {
			b.lastAgentMessage = text

		}
	}
	b.writeRecord(map[string]any{"type": "item.completed", "item": execItem})
}

// Delta content channels of one response window. Agent text and raw reasoning
// concatenate directly; reasoning summaries concatenate separately so they can
// be dropped when the same reasoning was already observed raw.
const (
	codexDeltaChannelText    = "text"
	codexDeltaChannelSummary = "reasoning-summary"
	codexDeltaChannelRaw     = "reasoning"
)

// codexDeltaWindow accumulates one response's observed generation: agent
// message text and raw reasoning concatenate per block in gen, while reasoning
// summaries concatenate in summaryGen and are merged only when no raw
// reasoning was observed, because a server streaming both renders the same
// reasoning twice. Tool output never arrives as a delta and is never counted.
type codexDeltaWindow struct {
	gen          tokenizerGeneration
	summaryGen   tokenizerGeneration
	rawReasoning bool
}

// observe accumulates one non-empty delta of the window into its content
// block. Timestamps come from the sampler's monotonic anchor at arrival, so a
// regressing stream marks the generation invalid.
func (w *codexDeltaWindow) observe(channel, block, text string, at int64) {
	if channel == codexDeltaChannelSummary {
		if w.rawReasoning {
			return
		}
		w.summaryGen.observe(block, text, at)
		return
	}
	if channel == codexDeltaChannelRaw {
		w.rawReasoning = true
	}
	w.gen.observe(block, text, at)
}

// measure counts the response as one window, combining observed channels before
// applying the duration threshold. Summaries replace unavailable raw reasoning.
func (w *codexDeltaWindow) measure() (tokens, first, last int64, ok bool) {
	if w.rawReasoning || w.summaryGen.blocks == nil {
		return w.gen.measure()
	}
	if w.gen.blocks == nil {
		return w.summaryGen.measure()
	}
	combined := tokenizerGeneration{blocks: make(map[string]*strings.Builder), firstMS: min(w.gen.firstMS, w.summaryGen.firstMS), lastMS: max(w.gen.lastMS, w.summaryGen.lastMS), invalid: w.gen.invalid || w.summaryGen.invalid}
	for key, block := range w.gen.blocks {
		combined.blocks[key] = block
	}
	for key, block := range w.summaryGen.blocks {
		combined.blocks[key] = block
	}
	return combined.measure()
}

// codexDeltaBlockKey names one streamed content block: the content channel,
// the item id, and for summaries the summary index.
func codexDeltaBlockKey(params map[string]any, channel string) string {
	item, _ := params["itemId"].(string)
	block := channel + "/" + item
	if index, ok := params["summaryIndex"].(float64); ok {
		block += "/" + strconv.FormatInt(int64(index), 10)
	}
	return block
}

// handleDelta accumulates one NON-EMPTY generation delta of the current
// response window, stamped with the sampler's monotonic anchor at arrival. A
// reasoning summary is ignored once raw reasoning was observed in the window:
// the server would otherwise re-render reasoning it already streamed raw. A
// response with no delta produces no sample at all.
func (b *codexAppServerBridge) handleDelta(params map[string]any, channel string) {
	if !b.withinTurn(params) {
		return
	}
	text := codexDeltaText(params)
	if text == "" {
		return
	}
	b.responseWindow.observe(channel, codexDeltaBlockKey(params, channel), text, b.sampler.timestamp(b.sampler.now()))
}

// handleRawResponseCompleted records the exact usage of one upstream Responses
// API completion. Every completion is accumulated into the current turn's usage
// total, including a tool-only completion that produced no delta.
//
// The per-response sampling window is reset on EVERY new completion, even one
// carrying no id or no usable usage: a window must never outlive the response
// that opened it. A completion whose id was already counted is ignored
// completely, so a retransmitted completion cannot double count usage or erase
// the next response's timing. The speed sample itself needs no usage: it is
// measured from the response's own observed deltas.
func (b *codexAppServerBridge) handleRawResponseCompleted(params map[string]any) {
	if !b.withinTurn(params) {
		return
	}
	responseID := codexStringField(params, "responseId", "response_id")
	if responseID != "" && b.responseUsageSeen[responseID] {
		// A completion already counted for this turn is ignored entirely: it
		// must neither double count usage nor disturb the window the NEXT
		// response has already opened.
		return
	}
	if responseID == "" {
		b.finishResponse()
		return
	}
	b.accumulateResponseUsage(params)
	b.responseUsageSeen[responseID] = true
	b.recordResponseSample(responseID)
	b.finishResponse()
}

// accumulateResponseUsage adds one completion's exact usage to the current
// turn. A missing usage object contributes nothing rather than a zero, so a
// tool-only or usage-less completion never fabricates a token estimate.
func (b *codexAppServerBridge) accumulateResponseUsage(params map[string]any) {
	usage, _ := params["usage"].(map[string]any)
	if usage == nil {
		return
	}
	if add, ok := codexTokenValueOK(usage, "inputTokens", "input_tokens"); ok {
		b.responseInputTokens += add
		b.responseUsageObserved = true
	}
	if add, ok := codexTokenValueOK(usage, "outputTokens", "output_tokens"); ok {
		b.responseOutputTokens += add
		b.responseUsageObserved = true
	}
	if add, ok := codexTokenValueOK(usage, "cachedInputTokens", "cached_input_tokens"); ok {
		b.responseCachedTokens += add
	}
}

// recordResponseSample closes the current response's observed generation into
// one tokenizer_v1 speed sample: the fixed-tokenizer count of its streamed
// content over the window from its first to its last non-empty delta. The
// completion's own arrival time is never part of the window, and official
// usage is not a prerequisite: usage accounting and the speed claim stay
// independent, so a completion with missing or unusable usage still yields
// its observable speed while billing stays exact.
func (b *codexAppServerBridge) recordResponseSample(responseID string) {
	tokens, first, last, ok := b.responseWindow.measure()
	if !ok || strings.TrimSpace(b.model) == "" {
		return
	}
	b.sampler.samples = append(b.sampler.samples, responseTPSSample{
		ResponseID:     responseID,
		Model:          b.model,
		OutputTokens:   tokens,
		FirstTokenAtMS: first,
		CompletedAtMS:  last,
	})
}

// finishResponse always closes the per-response generation window so no
// response's deltas bleed into the next one.
func (b *codexAppServerBridge) finishResponse() {
	b.responseWindow = codexDeltaWindow{}
	b.responseSeq++
}

// codexDeltaText extracts the non-empty text, reasoning, or partial JSON of a
// delta payload. The native delta notifications carry a flat delta string; the
// nested forms are tolerated for a lenient peer. An empty delta never opens a
// sampling window.
func codexDeltaText(params map[string]any) string {
	for _, key := range []string{"delta", "text", "textDelta"} {
		if text, ok := params[key].(string); ok && text != "" {
			return text
		}
	}
	if delta, ok := params["delta"].(map[string]any); ok {
		for _, key := range []string{"text", "delta", "thinking", "partialJson", "content"} {
			if text, ok := delta[key].(string); ok && text != "" {
				return text
			}
		}
	}
	return ""
}

// handleTurnCompleted emits the exec-shaped turn.completed record. The native
// turn status decides success: only a completed turn reports usage, while a
// failed or interrupted turn is a nonzero-failure turn.failed. turn/completed
// carries no usage of its own, so the usage comes from the current turn's
// accumulated raw response completions.
func (b *codexAppServerBridge) handleTurnCompleted(params map[string]any) {
	if !b.withinTurn(params) {
		return
	}
	turn, _ := params["turn"].(map[string]any)
	if turnID := codexTurnIdentity(params); turnID != "" {
		b.turnID = turnID
	}
	if status, _ := turn["status"].(string); codexTurnFailedStatus(status) {
		message := codexTurnFailureText(turn)
		if message == "" {
			message = "codex app-server: turn " + strings.ToLower(strings.TrimSpace(status))
		}
		b.failTurn(message)
		return
	}
	record := map[string]any{
		"type":        "turn.completed",
		"duration_ms": codexDurationMS(params, turn),
		"usage":       b.turnUsage(),
		"thread_id":   b.threadID,
		"session_id":  b.threadID,
	}
	b.attachSamples(record)
	b.writeRecord(record)
	b.turnCompleted = true
	b.terminal = true
}

// codexTurnFailedStatus reports whether a native turn status is a failure. Any
// non-completed terminal status counts: an interrupted turn is not a success.
func codexTurnFailedStatus(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "", "completed", "complete", "success", "succeeded", "done":
		return false
	default:
		return true
	}
}

// codexTurnFailureText extracts the failure message the turn carries.
func codexTurnFailureText(turn map[string]any) string {
	if turn == nil {
		return ""
	}
	if errorObj, ok := turn["error"].(map[string]any); ok {
		if message := codexStringField(errorObj, "message"); message != "" {
			return message
		}
	}
	return codexErrorText(turn)
}

// turnUsage renders the nested usage object the normalizer reads. It reports
// only what this turn's own raw responses actually carried: a turn with no
// observed usage emits no usage object rather than fabricated zeroes, and a
// legitimately zero count is preserved.
func (b *codexAppServerBridge) turnUsage() map[string]any {
	if !b.responseUsageObserved {
		return nil
	}
	usage := map[string]any{
		"input_tokens":  b.responseInputTokens,
		"output_tokens": b.responseOutputTokens,
	}
	if b.responseCachedTokens > 0 {
		usage["cached_input_tokens"] = b.responseCachedTokens
	}
	return usage
}

// attachSamples attaches the turn's tokenizer_v1 TPS samples and contract to a
// turn.completed record without ever weakening the usage fields.
func (b *codexAppServerBridge) attachSamples(record map[string]any) {
	b.sampler.takeSamples(record)
}

// handleErrorNotification handles the native error notification. An error the
// server will retry is a transient stream event, not the end of the turn: the
// turn stays open and its retry continues. Only a non-retryable error ends the
// turn as a failure.
func (b *codexAppServerBridge) handleErrorNotification(params map[string]any) {
	if !b.withinTurn(params) {
		return
	}
	if retrying, ok := params["willRetry"].(bool); ok && retrying {
		return
	}
	message := codexErrorText(params)
	if message == "" {
		message = "codex app-server: error"
	}
	b.failTurn(message)
}

// failTurn ends the turn as a failure. The failure is reported through the
// transcript and the run reports a nonzero exit code.
func (b *codexAppServerBridge) failTurn(message string) {
	b.emitTurnFailed(message)
	b.turnFailed = true
	b.terminal = true
}

// codexErrorText extracts a bounded failure message from an error payload.
func codexErrorText(params map[string]any) string {
	if errorObj, ok := params["error"].(map[string]any); ok {
		if message := codexStringField(errorObj, "message"); message != "" {
			return message
		}
	}
	for _, key := range []string{"message", "error", "detail"} {
		if message := codexStringField(params, key); message != "" {
			return message
		}
	}
	return ""
}

// emitTurnFailed writes the exec-shaped failure record once per run.
func (b *codexAppServerBridge) emitTurnFailed(message string) {
	if b.failureEmitted {
		return
	}
	b.failureEmitted = true
	b.writeRecord(map[string]any{"type": "turn.failed", "error": message})
}

// cancelTurn reports an interrupted turn. Usage observed before the
// interruption is still reported so accounting is not silently dropped, but no
// TPS claim is emitted because no response's observed window is trusted from
// an interrupted turn.
func (b *codexAppServerBridge) cancelTurn() {
	if b.turnCompleted || b.turnFailed {
		return
	}
	b.sampler.samples = nil
	b.emitTurnFailed("turn cancelled")
	b.turnFailed = true
	b.terminal = true
}

// transportEnded records a peer that vanished before the turn finished.
func (b *codexAppServerBridge) transportEnded(err error) {
	b.transportFailed = true
	b.transportErr = err
	b.terminal = true
}

// codexTokenValueOK reads one nonnegative integer token field and reports
// whether the field was actually present and usable.
func codexTokenValueOK(usage map[string]any, keys ...string) (int64, bool) {
	if usage == nil {
		return 0, false
	}
	for _, key := range keys {
		if raw, ok := usage[key]; ok {
			if tokens, ok := safeResponseOutputTokens(raw); ok {
				return tokens, true
			}
		}
	}
	return 0, false
}

// codexDurationMS reads the client-reported turn duration when present.
func codexDurationMS(params, turn map[string]any) int64 {
	for _, source := range []map[string]any{turn, params} {
		if source == nil {
			continue
		}
		for _, key := range []string{"durationMs", "duration_ms"} {
			if raw, ok := source[key]; ok {
				if value, ok := safeResponseOutputTokens(raw); ok {
					return value
				}
			}
		}
	}
	return 0
}

// codexAgentMessageText extracts the assistant text of an agent message item.
func codexAgentMessageText(item map[string]any) string {
	if text := codexStringField(item, "text", "content"); text != "" {
		return text
	}
	if content, ok := item["content"].([]any); ok {
		parts := make([]string, 0, len(content))
		for _, entry := range content {
			if block, ok := entry.(map[string]any); ok {
				parts = append(parts, codexStringField(block, "text"))
			}
		}
		return strings.TrimSpace(strings.Join(parts, ""))
	}
	return ""
}
