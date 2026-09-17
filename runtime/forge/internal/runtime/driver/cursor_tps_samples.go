package driver

import (
	"bytes"
	"encoding/json"
	"strings"
)

// cursorGenerationWindow is one serial model-generation interval inside a
// single Cursor agent turn together with the approximate tokens of the
// content the stream actually observed in it: it starts at the first nonempty
// text/thinking delta and ends at the last nonempty delta of that generation.
type cursorGenerationWindow struct {
	Tokens         int64
	FirstTokenAtMS int64
	CompletedAtMS  int64
}

// cursorTPSSample is the single aggregate sample for one complete Cursor
// terminal turn. OutputTokens is the sum of the approximate tokenizer counts
// of the valid generation windows, never the terminal official usage (which
// stays untouched as the billing record); GenerationWindows is the ordered
// list of the valid serial generation intervals observed on the stream.
type cursorTPSSample struct {
	ResponseID        string
	Model             string
	OutputTokens      int64
	GenerationWindows []cursorGenerationWindow
}

// cursorTPSState is the sampling state machine for one Cursor invocation. Any
// structural surprise (retry, reconnect, error, interaction query, malformed
// timing, session change, unknown tool
// completion, truncated or duplicate terminal) invalidates the stream. An unobservable
// (buffered or collapsed) generation window is merely skipped, so it never
// poisons the other complete valid windows.
type cursorTPSState struct {
	poisoned bool
	// started is true once the first native record has been observed.
	started bool
	session string
	// initSeen counts native system/init records so multiple init/model
	// changes can be rejected.
	initSeen int

	// lastTimestampMS is the globally observed millisecond boundary. Every
	// present timestamp_ms must be valid and nondecreasing.
	lastTimestampMS int64

	// terminalRequestID is the nonempty request_id carried by the terminal
	// result. It becomes the sample response_id.
	terminalRequestID string
	terminalSeen      bool
	terminalOK        bool

	// generation accumulates the observable content of the active serial
	// model-generation window, one block per content channel (text/thinking).
	generation tokenizerGeneration
	// inGeneration is true once the active generation window has observed its
	// first nonempty delta.
	inGeneration bool
	// lastDeltaMS is the most recent nonempty delta boundary, which is the
	// observable completion of the active (possibly not yet closed) window.
	lastDeltaMS int64

	// Parallel tools may share a model call. Only generation observed outside
	// outstanding tool execution is measurable.
	pendingTools map[string]string
	callIDs      map[string]bool

	// partialText is the text accumulated from assistant records that carry a
	// timestamp but no model_call_id. An assistant record with no timestamp or
	// with a model_call_id is a summary only when its text equals this
	// accumulation; otherwise it is a coverage gap.
	partialText strings.Builder

	windows []cursorGenerationWindow
}

func newCursorTPSState() cursorTPSState {
	return cursorTPSState{
		pendingTools: make(map[string]string),
		callIDs:      make(map[string]bool),
	}
}

// cursorTPSSampler observes raw Cursor stream-json lines and, only when the
// entire stream passes, yields one aggregate tokenizer_v1 sample.
type cursorTPSSampler struct {
	state cursorTPSState
}

func newCursorTPSSampler() cursorTPSSampler {
	return cursorTPSSampler{state: newCursorTPSState()}
}

// observe consumes one raw Cursor stream-json line. Every line is fed here
// before normalization so a malformed or unsupported record still poisons the
// sample. Text reconstruction remains independent of sampling validity.
func (s *cursorTPSSampler) observe(line []byte) {
	if s.state.poisoned {
		return
	}
	line = trimJSONLineSpace(line)
	if len(line) == 0 {
		return
	}
	var record map[string]any
	if err := json.Unmarshal(line, &record); err != nil || record == nil {
		s.state.poisoned = true
		return
	}
	typ, _ := getString(record, "type")
	typ = strings.ToLower(strings.TrimSpace(typ))
	// A record observed after the terminal result means the stream continued
	// past its terminal boundary: duplicate or truncated.
	if s.state.terminalSeen {
		s.state.poisoned = true
		return
	}
	if session := cursorRecordSessionID(record); s.state.session != "" && session != "" && session != s.state.session {
		s.state.poisoned = true
		return
	}
	s.state.started = true
	// Every present timestamp_ms must be a positive safe integer and must be
	// globally nondecreasing; result/init records legitimately carry none.
	if ok := s.state.observeTimestamp(record); !ok {
		return
	}

	switch typ {
	case "system":
		s.observeSystem(record)
	case "connection", "retry", "retried", "reconnect", "reconnected", "interaction_query":
		s.state.poisoned = true
	case "thinking":
		s.observeThinking(record)
	case "assistant":
		s.observeAssistant(record)
	case "tool_call":
		s.observeToolCall(record)
	case "result":
		s.observeResult(record)
	case "user":
		if s.state.inGeneration || len(s.state.windows) != 0 || len(s.state.pendingTools) != 0 {
			s.state.poisoned = true
		}
	default:
		s.state.poisoned = true
	}
	return
}

// observeTimestamp validates every present top-level timestamp_ms and enforces
// global nondecreasing order. A record with an absent timestamp is legal; a
// present but malformed, negative, or regressing value poisons the stream.
func (s *cursorTPSState) observeTimestamp(record map[string]any) bool {
	raw, present := record["timestamp_ms"]
	if !present {
		return true
	}
	at, ok := cursorTimestampValue(raw)
	if !ok {
		s.poisoned = true
		return false
	}
	if s.started && at < s.lastTimestampMS {
		s.poisoned = true
		return false
	}
	s.lastTimestampMS = at
	return true
}

// observeSystem validates the single model init boundary. Init must be unique
// and carry a nonempty native session and model; a second init ends the init
// phase and is a mid-stream model or session change.
func (s *cursorTPSSampler) observeSystem(record map[string]any) {
	subtype, _ := getString(record, "subtype")
	if !strings.EqualFold(strings.TrimSpace(subtype), "init") {
		s.state.poisoned = true
		return
	}
	s.state.initSeen++
	if s.state.initSeen > 1 {
		s.state.poisoned = true
		return
	}
	session := cursorRecordSessionID(record)
	if session == "" {
		s.state.poisoned = true
		return
	}
	s.state.session = session
	if strings.TrimSpace(cursorStringField(record, "model")) == "" {
		s.state.poisoned = true
	}
}

// observeThinking records a nonempty reasoning delta as generation activity.
// The phase boundary record (thinking/completed) is not itself a delta but its
// timestamp still participates in the global order check.
func (s *cursorTPSSampler) observeThinking(record map[string]any) {
	subtype, _ := getString(record, "subtype")
	if strings.EqualFold(strings.TrimSpace(subtype), "completed") {
		return
	}
	if subtype != "delta" {
		s.state.poisoned = true
		return
	}
	text := cursorRecordText(record)
	if text == "" {
		return
	}
	if len(s.state.pendingTools) != 0 {
		return
	}
	at, ok := cursorEventTimestamp(record)
	if !ok {
		s.state.poisoned = true
		return
	}
	s.markGenerationActivity("thinking", text, at)
}

// observeAssistant records a nonempty assistant delta. An assistant record
// carrying a model_call_id, or whose text equals the accumulated partial text,
// is a summary flush of text already seen: it never opens or extends a
// generation window. A timestamped assistant record with no model_call_id is a
// genuine delta and accumulates as partial text.
func (s *cursorTPSSampler) observeAssistant(record map[string]any) {
	text := cursorRecordText(record)
	if text == "" {
		return
	}
	if hasCursorField(record, "model_call_id") {
		if s.state.partialText.Len() == 0 || text != s.state.partialText.String() {
			s.state.poisoned = true
		}
		s.state.partialText.Reset()
		return
	}
	at, ok := cursorEventTimestamp(record)
	if !ok {
		// Without a timestamp the record is only legal as a summary of the
		// accumulated partial text.
		if s.state.partialText.Len() == 0 || text != s.state.partialText.String() {
			s.state.poisoned = true
			return
		}
		s.state.partialText.Reset()
		return
	}
	s.state.partialText.WriteString(text)
	if len(s.state.pendingTools) != 0 {
		return
	}
	s.markGenerationActivity("text", text, at)
}

// observeToolCall tracks matching tool boundaries, including parallel calls.
func (s *cursorTPSSampler) observeToolCall(record map[string]any) {
	subtype, _ := getString(record, "subtype")
	subtype = strings.ToLower(strings.TrimSpace(subtype))
	switch subtype {
	case "started":
		s.observeToolStarted(record)
	case "completed":
		s.observeToolCompleted(record)
	default:
		s.state.poisoned = true
	}
}

func (s *cursorTPSSampler) observeToolStarted(record map[string]any) {
	callID := strings.TrimSpace(cursorStringField(record, "call_id"))
	if callID == "" {
		s.state.poisoned = true
		return
	}
	modelCallID := strings.TrimSpace(cursorStringField(record, "model_call_id"))
	if modelCallID == "" {
		s.state.poisoned = true
		return
	}
	// Background tools and subagents have unclear aggregate token coverage.
	if cursorToolExcluded(record) {
		s.state.poisoned = true
		return
	}
	if s.state.callIDs[callID] {
		s.state.poisoned = true
		return
	}
	at, ok := cursorEventTimestamp(record)
	if !ok {
		s.state.poisoned = true
		return
	}
	// A tool start can never precede the last delta of the generation it
	// closes. A tool start without a preceding generation window is legal: a
	// tool-only model response simply contributes no window.
	if s.state.inGeneration && at < s.state.lastDeltaMS {
		s.state.poisoned = true
		return
	}
	// The active window closes at its own last nonempty delta: the interval
	// from that delta to the tool start is completion latency, not generation.
	s.closeGeneration()
	s.state.callIDs[callID] = true
	s.state.pendingTools[callID] = modelCallID
}

func (s *cursorTPSSampler) observeToolCompleted(record map[string]any) {
	callID := strings.TrimSpace(cursorStringField(record, "call_id"))
	if callID == "" {
		s.state.poisoned = true
		return
	}
	if s.state.pendingTools[callID] == "" {
		s.state.poisoned = true
		return
	}
	if modelCallID := strings.TrimSpace(cursorStringField(record, "model_call_id")); modelCallID == "" || modelCallID != s.state.pendingTools[callID] {
		s.state.poisoned = true
		return
	}
	if _, ok := cursorEventTimestamp(record); !ok {
		s.state.poisoned = true
		return
	}
	delete(s.state.pendingTools, callID)
}

// observeResult validates the single successful terminal of the turn. The
// terminal must be the last record and must carry a nonempty request_id, a
// session consistent with init, and a complete integral nonnegative usage
// output count.
func (s *cursorTPSSampler) observeResult(record map[string]any) {
	status, _, terminal := cursorTerminalOutcome("result", record)
	if !terminal || status != "done" {
		s.state.poisoned = true
		return
	}
	requestID := strings.TrimSpace(cursorStringField(record, "request_id"))
	if requestID == "" {
		s.state.poisoned = true
		return
	}
	if len(s.state.pendingTools) != 0 {
		s.state.poisoned = true
		return
	}
	if session := cursorRecordSessionID(record); session != "" && s.state.session != "" && session != s.state.session {
		s.state.poisoned = true
		return
	}
	// The final window, if any, closes at its own last nonempty delta; a turn
	// whose only generations were unobservable simply ends with no window.
	s.closeGeneration()
	usage := cursorUsage(record)
	if usage == nil {
		s.state.poisoned = true
		return
	}
	_, ok := safeResponseOutputTokens(usage["output_tokens"])
	if !ok {
		s.state.poisoned = true
		return
	}
	s.state.terminalRequestID = requestID
	s.state.terminalOK = true
	s.state.terminalSeen = true
}

// markGenerationActivity opens or extends the active generation window from a
// nonempty delta, accumulating its content as one block per content channel so
// the count never depends on how the CLI splits its stream. Timestamps must
// be present and monotonic.
func (s *cursorTPSSampler) markGenerationActivity(channel, text string, at int64) {
	if s.state.inGeneration && at < s.state.lastDeltaMS {
		s.state.poisoned = true
		return
	}
	s.state.inGeneration = true
	s.state.generation.observe(channel, text, at)
	s.state.lastDeltaMS = at
}

// closeGeneration ends the active generation window at its last nonempty
// delta. A window that never spanned the minimum observable interval (a
// buffered or collapsed CLI stream) is skipped without poisoning the stream,
// so other complete valid windows still produce a sample.
func (s *cursorTPSSampler) closeGeneration() {
	if !s.state.inGeneration {
		return
	}
	s.state.inGeneration = false
	generation := s.state.generation
	s.state.generation = tokenizerGeneration{}
	tokens, first, last, ok := generation.measure()
	if !ok {
		return
	}
	s.state.windows = append(s.state.windows, cursorGenerationWindow{
		Tokens:         tokens,
		FirstTokenAtMS: first,
		CompletedAtMS:  last,
	})
}

// finalize returns the single aggregate sample, or false when the stream did
// not pass. No sample is produced unless the whole turn is covered: it requires
// exactly one init, a nonempty session, at least one valid generation window,
// and a valid successful terminal. The sample tokens are the aggregate of the
// per-window approximate counts, never the terminal official usage.
func (s *cursorTPSSampler) finalize(usage map[string]any) (cursorTPSSample, bool) {
	if s.state.poisoned || !s.state.terminalOK || !s.state.terminalSeen || !s.state.started {
		return cursorTPSSample{}, false
	}
	if s.state.initSeen != 1 || s.state.session == "" {
		return cursorTPSSample{}, false
	}
	if s.state.inGeneration || len(s.state.windows) == 0 {
		return cursorTPSSample{}, false
	}
	// The terminal official usage remains a validity gate for the canonical
	// turn, but its counts are never attributed to the speed sample.
	if _, ok := safeResponseOutputTokens(usage["output_tokens"]); !ok {
		return cursorTPSSample{}, false
	}
	var tokens int64
	for _, window := range s.state.windows {
		tokens += window.Tokens
	}
	return cursorTPSSample{
		ResponseID:        "cursor-turn:" + s.state.terminalRequestID,
		OutputTokens:      tokens,
		GenerationWindows: s.state.windows,
	}, true
}

// cursorRecordSessionID extracts a native session id from a Cursor record.
func cursorRecordSessionID(record map[string]any) string {
	for _, key := range []string{"session_id", "sessionId", "native_session_id", "conversation_id"} {
		if value := strings.TrimSpace(cursorStringField(record, key)); value != "" {
			return value
		}
	}
	return ""
}

// cursorEventTimestamp extracts the top-level millisecond timestamp when it is
// present and valid.
func cursorEventTimestamp(record map[string]any) (int64, bool) {
	raw, present := record["timestamp_ms"]
	if !present {
		return 0, false
	}
	return cursorTimestampValue(raw)
}

// cursorTimestampValue accepts only a positive safe-integer millisecond value.
// A missing, fractional, zero, negative, huge, or non-numeric representation is
// not a valid boundary.
func cursorTimestampValue(raw any) (int64, bool) {
	var value int64
	switch typed := raw.(type) {
	case json.Number:
		parsed, err := typed.Int64()
		if err != nil {
			return 0, false
		}
		value = parsed
	case float64:
		if typed != float64(int64(typed)) {
			return 0, false
		}
		value = int64(typed)
	case int:
		value = int64(typed)
	case int64:
		value = typed
	default:
		return 0, false
	}
	if value <= 0 || value > 1<<53-1 {
		return 0, false
	}
	return value, true
}

// cursorRecordText returns the text carried by an assistant/thinking delta: the
// top-level text, or the concatenated text blocks of nested message.content.
func cursorRecordText(record map[string]any) string {
	if text := cursorStringField(record, "text"); text != "" {
		return text
	}
	return cursorAssistantText(record)
}

// cursorStringField reads one string field, returning "" when absent or
// non-string.
func cursorStringField(record map[string]any, key string) string {
	value, _ := getString(record, key)
	return value
}

func hasCursorField(record map[string]any, key string) bool {
	value, present := record[key]
	if !present {
		return false
	}
	if text, ok := value.(string); ok {
		return strings.TrimSpace(text) != ""
	}
	return value != nil
}

// cursorToolExcluded rejects tool records whose aggregate token coverage is
// unclear: a subagent/background task tool identified by its actual tool_call
// key, or nested args carrying isBackground=true.
func cursorToolExcluded(record map[string]any) bool {
	for _, key := range []string{"taskToolCall", "subagentToolCall"} {
		raw, present := record[key]
		if !present || raw == nil {
			continue
		}
		inner, ok := raw.(map[string]any)
		if !ok {
			return true
		}
		if cursorArgsBackground(inner["args"]) {
			return true
		}
	}
	if cursorArgsBackground(record["args"]) {
		return true
	}
	if toolCall, ok := record["tool_call"].(map[string]any); ok {
		for key, value := range toolCall {
			if isCursorBackgroundToolKey(key) {
				return true
			}
			inner, isMap := value.(map[string]any)
			if !isMap {
				continue
			}
			if cursorArgsBackground(inner["args"]) {
				return true
			}
		}
	}
	return false
}

// isCursorBackgroundToolKey reports whether a tool key names a subagent or task
// tool, which never has clear aggregate token coverage.
func isCursorBackgroundToolKey(key string) bool {
	lowered := strings.ToLower(key)
	return strings.Contains(lowered, "task") || strings.Contains(lowered, "subagent")
}

func cursorArgsBackground(raw any) bool {
	switch value := raw.(type) {
	case map[string]any:
		if background, ok := value["isBackground"].(bool); ok && background {
			return true
		}
		for _, nested := range value {
			if cursorArgsBackground(nested) {
				return true
			}
		}
		return false
	case string:
		trimmed := strings.TrimSpace(value)
		if trimmed == "" || trimmed[0] != '{' {
			return false
		}
		var nested map[string]any
		if err := json.Unmarshal([]byte(trimmed), &nested); err != nil {
			return false
		}
		return cursorArgsBackground(nested)
	case []any:
		for _, nested := range value {
			if cursorArgsBackground(nested) {
				return true
			}
		}
	}
	return false
}

// attachCursorTPSSample writes the single aggregate tokenizer_v1 sample onto
// canonical usage data. Callers invoke it only when the entire stream passed.
// The canonical official usage fields are never modified: the sample carries
// only the approximate tokenizer counts of the observed generation windows.
func attachCursorTPSSample(data map[string]any, sample cursorTPSSample) {
	if data == nil {
		return
	}
	windows := make([]any, 0, len(sample.GenerationWindows))
	for _, window := range sample.GenerationWindows {
		windows = append(windows, map[string]any{
			"tokens":            window.Tokens,
			"first_token_at_ms": window.FirstTokenAtMS,
			"completed_at_ms":   window.CompletedAtMS,
		})
	}
	data["tps_sampling_contract"] = tokenizerTPSSamplingContract
	data["tps_samples"] = []any{map[string]any{
		"response_id":        sample.ResponseID,
		"model":              sample.Model,
		"output_tokens":      sample.OutputTokens,
		"generation_windows": windows,
	}}
}

// cursorAssistantTextDeduper is the single shared lookahead helper that removes
// the aggregate assistant summary flushes the Cursor CLI emits alongside the
// partial deltas. Every consumer feeds it each raw record and appends the
// returned text, so the streaming Tee and the line-based ParseResult can never
// disagree about which records are duplicates.
type cursorAssistantTextDeduper struct {
	// accumulated is the real text already forwarded for this turn.
	accumulated strings.Builder
	// pending is a timestamped assistant text waiting for the next record to
	// decide whether it was real content or the CLI's own summary flush.
	pending string
}

// observe consumes one raw record and returns the real turn text it contributed:
// the previously pending text is flushed as real content unless this record
// proves it was a summary, and the record's own qualifying text is forwarded,
// held, or suppressed.
func (d *cursorAssistantTextDeduper) observe(record map[string]any) string {
	if record == nil {
		return ""
	}
	typ, _ := getString(record, "type")
	return d.observeType(typ, record)
}

// observeType is the shared rule body over an already-extracted record type,
// usable on every raw record.
func (d *cursorAssistantTextDeduper) observeType(typ string, record map[string]any) string {
	if record == nil {
		return ""
	}
	lowered := strings.ToLower(strings.TrimSpace(typ))
	text := cursorRecordText(record)
	// A retry/reconnect or interaction query whose text repeats the whole
	// accumulation is the CLI's summary of that text, not new content: the
	// suppression evidence also clears the accumulation.
	if (lowered == "retry" || lowered == "retried" || lowered == "reconnect" || lowered == "reconnected" || lowered == "interaction_query") &&
		d.pending != "" && d.accumulated.Len() != 0 && d.pending == d.accumulated.String() {
		d.pending = ""
		d.accumulated.Reset()
		return ""
	}
	out := d.flushPending()
	if lowered != "assistant" || text == "" {
		return out
	}
	_, hasTimestamp := record["timestamp_ms"]
	hasModelCallID := hasCursorField(record, "model_call_id")
	if hasModelCallID || !hasTimestamp {
		// Summary flushes only ever repeat what was already accumulated.
		if d.accumulated.Len() != 0 && text == d.accumulated.String() {
			d.accumulated.Reset()
			return out
		}
		d.accumulated.Reset()
		return out + text
	}
	// A timestamped delta with no model_call_id may still be the summary flush
	// of the partial text; hold it until the next record decides.
	d.pending = text
	return out
}

// observeLine parses one raw JSON line and applies the same shared rule body,
// so a line-based consumer can never disagree with a record-based one.
func (d *cursorAssistantTextDeduper) observeLine(line []byte) string {
	var record map[string]any
	if err := json.Unmarshal(trimJSONLineSpace(line), &record); err != nil {
		record = nil
	}
	return d.observe(record)
}

// flushPending promotes any held text to real accumulated text and returns it.
func (d *cursorAssistantTextDeduper) flushPending() string {
	text := d.pending
	d.pending = ""
	d.accumulated.WriteString(text)
	return text
}

// finish flushes any still-held text, for truncated logs.
func (d *cursorAssistantTextDeduper) finish() string {
	text := d.pending
	d.pending = ""
	d.accumulated.WriteString(text)
	return text
}

func trimJSONLineSpace(line []byte) []byte {
	return bytes.TrimSpace(line)
}
