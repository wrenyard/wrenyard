package execution

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/protocol"
)

// Execute runs the full direct execution boundary and returns the normalized
// Result. It performs no presentation; the root CLI calls Run for presentation
// or tests call Execute directly. It preserves the exact current gate/error/
// side-effect order and text from the root direct runtime.
func Execute(req Request, deps Dependencies, stdout, stderr io.Writer) (Result, error) {
	return executeResilient(req, deps, stdout, stderr)
}

// Run owns the current presentation/error/exit decision so the root CLI need
// only call it. It returns the result and a process exit code suitable for
// os.Exit by the caller.
func Run(req Request, deps Dependencies, stdout, stderr io.Writer) (Result, int) {
	result, err := Execute(req, deps, stdout, stderr)
	if err != nil {
		if req.Format == protocol.OutputFormatJSON {
			data, mErr := json.MarshalIndent(result, "", "  ")
			if mErr == nil {
				fmt.Fprintln(stdout, string(data))
			}
		} else if req.Format != protocol.OutputFormatStreamJSON {
			fmt.Fprintln(stderr, err)
		}
		return result, 1
	}
	return result, printResult(result, req.Format, stdout, stderr)
}

func printResult(result Result, format protocol.OutputFormat, stdout, stderr io.Writer) int {
	switch format {
	case protocol.OutputFormatJSON:
		data, err := json.MarshalIndent(result, "", "  ")
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		fmt.Fprintln(stdout, string(data))
	case protocol.OutputFormatStreamJSON:
		// Stream output is emitted during execution.
	default:
		if strings.TrimSpace(result.Summary) != "" {
			fmt.Fprintln(stdout, result.Summary)
		}
	}
	if result.Status != "done" {
		return 1
	}
	return 0
}

// eventSink aggregates normalized events into the result and (in stream mode)
// emits Stream v1 envelopes in order with a shared run_id/seq/timestamps. It
// owns no Forge session state.
type eventSink struct {
	mu      sync.Mutex
	out     io.Writer
	format  protocol.OutputFormat
	result  Result
	stream  bool
	encoder *json.Encoder
	runID   string
	seq     int
	clock   Clock
	events  []protocol.Event
	// normalizedFailure is set once a codec hands the sink an unknown or
	// malformed normalized event. From that point the attempt is poisoned: the
	// recorded snapshot is replaced with a single privacy-safe failed
	// run_finished and every later event is dropped, so the attempt fails
	// closed and no native payload reaches the public stream or result.
	normalizedFailure bool
}

const normalizedEventValidationError = "normalized event failed schema validation"

func newEventSink(out io.Writer, format protocol.OutputFormat, result Result) *eventSink {
	return newEventSinkWithClock(out, format, result, realClock{})
}

func newEventSinkWithClock(out io.Writer, format protocol.OutputFormat, result Result, clock Clock) *eventSink {
	if clock == nil {
		clock = realClock{}
	}
	s := &eventSink{
		out:    out,
		format: format,
		result: result,
		stream: format == protocol.OutputFormatStreamJSON,
		clock:  clock,
	}
	if s.stream {
		s.encoder = json.NewEncoder(out)
		s.runID = newRunID()
	}
	return s
}

func (s *eventSink) handleNormalizedEvent(event protocol.Event) {
	s.mu.Lock()
	defer s.mu.Unlock()
	// Once a malformed/unknown normalized event has been observed the attempt
	// is poisoned: drop every later event so no native payload can mask the
	// failure or leak into the snapshot/stream.
	if s.normalizedFailure {
		return
	}
	// Centralized Forge v1 schema gate: malformed or unknown adapter events
	// fail closed. The offending event is never emitted and its data never
	// retained; the snapshot is replaced with one privacy-safe failed
	// run_finished so the child attempt terminates through a normalized error
	// without leaking any native payload.
	if err := protocol.ValidateEvent(event); err != nil {
		s.recordNormalizedFailureLocked()
		return
	}
	s.events = append(s.events, protocol.Event{Type: event.Type, Data: copyEventData(event.Data)})
	switch event.Type {
	case protocol.EventMessage:
		if text, ok := event.Data["text"].(string); ok && strings.TrimSpace(text) != "" {
			s.result.Summary = strings.TrimSpace(text)
		}
	case protocol.EventTurnUsage:
		s.result.Usage = copyEventData(event.Data)
	}
	// A normalized run_finished describes one child attempt. The orchestrator
	// remaps it to attempt_finished or emits the sole public terminal event.
	if s.stream && event.Type != protocol.EventRunFinished {
		s.emitLocked(event.Type, event.Data)
	}
}

// recordNormalizedFailureLocked replaces the recorded snapshot with a single
// privacy-safe failed terminal event and poisons the attempt. It must be called
// with s.mu held.
func (s *eventSink) recordNormalizedFailureLocked() {
	s.normalizedFailure = true
	s.events = []protocol.Event{{
		Type: protocol.EventRunFinished,
		Data: map[string]any{"status": "failed", "error": normalizedEventValidationError},
	}}
}

func (s *eventSink) beginAttempt() {
	s.mu.Lock()
	s.events = nil
	s.normalizedFailure = false
	s.mu.Unlock()
}

// failedValidation reports whether a codec handed the sink an unknown or
// malformed normalized event during the current attempt. The orchestrator
// consults it so a directly-provided (non-streamed) event slice fails closed
// through the privacy-safe snapshot rather than the raw child events.
func (s *eventSink) failedValidation() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.normalizedFailure
}

func (s *eventSink) attemptSnapshot() []protocol.Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]protocol.Event, len(s.events))
	for i, event := range s.events {
		out[i] = protocol.Event{Type: event.Type, Data: copyEventData(event.Data)}
	}
	return out
}

func (s *eventSink) resultSnapshot() Result {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := s.result
	if result.Usage != nil {
		result.Usage = copyEventData(result.Usage)
	}
	return result
}

func (s *eventSink) emit(typ string, data map[string]any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.emitLocked(typ, data)
}

func (s *eventSink) emitLocked(typ string, data map[string]any) {
	if !s.stream || s.encoder == nil {
		return
	}
	s.seq += 1
	payload := protocol.Envelope{
		Data:      copyEventData(data),
		Protocol:  protocol.StreamProtocol,
		RunID:     s.runID,
		Seq:       s.seq,
		Timestamp: s.clock.Now().UTC(),
		Type:      typ,
		Version:   protocol.StreamVersion,
	}
	_ = s.encoder.Encode(payload)
}

func copyEventData(data map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range data {
		out[k] = v
	}
	return out
}

// newRunID produces a public wire run id prefixed fr_ (preserved as wire
// behavior). It never leaks the secret credential value.
func newRunID() string {
	var raw [8]byte
	if _, err := rand.Read(raw[:]); err == nil {
		return "fr_" + hex.EncodeToString(raw[:])
	}
	return fmt.Sprintf("fr_%d", time.Now().UTC().UnixNano())
}
