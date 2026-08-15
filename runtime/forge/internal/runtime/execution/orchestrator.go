package execution

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/grok"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/driver"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/protocol"
)

type profileOutcome struct {
	result         ChildResult
	classification Classification
	summary        protocol.AttemptSummary
	recoveryAt     *time.Time
	circuit        *CircuitRecord
	terminal       bool
}

const invalidGrokNativeOutputError = "invalid or incomplete Grok native output"

func executeResilient(req Request, deps Dependencies, stdout, stderr interfaceWriter) (Result, error) {
	ctx := req.Context
	if ctx == nil {
		ctx = context.Background()
	}
	clock := deps.Clock
	if clock == nil {
		clock = realClock{}
	}
	sleeper := deps.Sleeper
	if sleeper == nil {
		sleeper = realSleeper{}
	}
	jitter := deps.JitterFn
	if jitter == nil {
		jitter = productionJitter
	}
	runner := deps.Runner
	if runner == nil {
		runner = defaultChildRunner
	}

	candidates, policy := requestCandidates(req)
	initialResult := Result{Status: "running"}
	if len(candidates) > 0 {
		initialResult.Profile = candidates[0]
	}
	sink := newEventSinkWithClock(stdout, req.Format, initialResult, clock)
	if req.Format == protocol.OutputFormatStreamJSON {
		started := map[string]any{"selector": selectorName(req, policy)}
		if policy {
			started["policy"] = req.PolicyName
			// Emit the already-resolved first candidate so Foreman can persist
			// the resolved profile while the run is still in flight.
			if initialResult.Profile != "" {
				started["profile"] = initialResult.Profile
			}
		} else {
			started["profile"] = req.ProfileName
		}
		// Truthful non-empty provenance for a normal valid run: the primary
		// candidate's public client family and concrete adapter identity, plus
		// the resolved working directory.
		family, client := resolveStartedClientIdentity(candidates, req, deps)
		if family != "" {
			started["client_family"] = family
		}
		if client != "" {
			started["client"] = client
		}
		if cwd, err := resolveWorkDir(req.WorkDir); err == nil {
			started["cwd"] = cwd
		}
		sink.emit(protocol.EventRunStarted, started)
	}

	store := NewCircuitStore(deps.StateRoot, clock)
	var summaries []protocol.AttemptSummary
	var circuitProfiles []string
	circuitUnlocks := map[string]string{}
	var final Result
	var finalErr error

	for index, profileName := range candidates {
		if err := ctx.Err(); err != nil {
			final = failureResult(req, profileName, FailureClassNonRetryable, err.Error(), summaries, circuitProfiles, circuitUnlocks)
			finalErr = err
			break
		}
		check := store.Check(profileName)
		if check.Unlocked && req.Format == protocol.OutputFormatStreamJSON {
			sink.emit(protocol.EventCircuitUnlocked, map[string]any{"profile": profileName})
		}
		if check.Open {
			summaries = append(summaries, protocol.AttemptSummary{Profile: profileName})
			addCircuitObservation(profileName, check.Record, &circuitProfiles, circuitUnlocks)
			if !policy {
				final = failureResult(req, profileName, check.Record.Classification, "profile circuit is open", summaries, circuitProfiles, circuitUnlocks)
				finalErr = terminalError(final)
				break
			}
			next := nextCandidate(candidates, index)
			emitPolicyFallback(sink, profileName, next, "circuit_open", check.Record.UnlockAt)
			continue
		}

		outcome := executeProfile(ctx, req, profileName, deps, sink, sleeper, jitter, runner, stderr)
		summaries = append(summaries, outcome.summary)
		if outcome.result.Status == "done" && outcome.classification == ClassificationNone {
			final = successResult(req, profileName, outcome.result, summaries, circuitProfiles, circuitUnlocks, sink)
			finalErr = nil
			break
		}
		if outcome.terminal {
			final = failedAttemptResult(req, profileName, outcome, summaries, circuitProfiles, circuitUnlocks, sink)
			finalErr = terminalError(final)
			break
		}
		if outcome.circuit != nil {
			addCircuitObservation(profileName, outcome.circuit, &circuitProfiles, circuitUnlocks)
			if !policy {
				final = failedAttemptResult(req, profileName, outcome, summaries, circuitProfiles, circuitUnlocks, sink)
				finalErr = terminalError(final)
				break
			}
			next := nextCandidate(candidates, index)
			emitPolicyFallback(sink, profileName, next, outcome.circuit.ReasonCode, outcome.circuit.UnlockAt)
			continue
		}
		// A failed outcome without a terminal or circuit is only possible when
		// the context was cancelled between attempts.
		final = failedAttemptResult(req, profileName, outcome, summaries, circuitProfiles, circuitUnlocks, sink)
		finalErr = terminalError(final)
		break
	}

	if final.Status == "" {
		if policy {
			final = Result{
				Status:          "failed",
				Profile:         lastOr(candidates),
				FailureClass:    string(FailureClassPolicyExhausted),
				Error:           "all profile-policy candidates exhausted",
				ExitCode:        1,
				CircuitProfiles: append([]string(nil), circuitProfiles...),
				CircuitUnlockAt: copyStringMap(circuitUnlocks),
				Attempts:        append([]protocol.AttemptSummary(nil), summaries...),
			}
			finalErr = terminalError(final)
		} else {
			profileName := req.ProfileName
			final = failureResult(req, profileName, FailureClassNonRetryable, "profile execution did not complete", summaries, circuitProfiles, circuitUnlocks)
			finalErr = terminalError(final)
		}
	}
	if req.Format == protocol.OutputFormatStreamJSON {
		sink.emit(protocol.EventRunFinished, finalEventData(final))
	}
	if finalErr != nil {
		return final, finalErr
	}
	return final, nil
}

// interfaceWriter lets the orchestration layer keep io.Writer out of its
// public contracts while retaining the existing output call shape.
type interfaceWriter interface {
	Write([]byte) (int, error)
}

func requestCandidates(req Request) ([]string, bool) {
	if strings.EqualFold(req.Selector, "policy") || req.PolicyName != "" || len(req.PolicyCandidates) > 0 {
		return append([]string(nil), req.PolicyCandidates...), true
	}
	if strings.TrimSpace(req.ProfileName) == "" {
		return nil, false
	}
	return []string{req.ProfileName}, false
}

// resolveStartedClientIdentity resolves the public client family and the
// concrete native adapter client of the primary candidate so run_started
// carries truthful provenance before the first attempt begins. The public
// client_family stays compatibility-compatible (claude for CodeBuddy) while the
// additive client identifies the concrete adapter.
func resolveStartedClientIdentity(candidates []string, req Request, deps Dependencies) (family, client string) {
	name := req.ProfileName
	if len(candidates) > 0 {
		name = candidates[0]
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return "", ""
	}
	def, ok, err := deps.LoadProfile(name)
	if err != nil || !ok {
		return "", ""
	}
	return clientFamily(def), strings.TrimSpace(def.Client)
}

func selectorName(req Request, policy bool) string {
	if policy || strings.EqualFold(req.Selector, "policy") {
		return "policy"
	}
	return "profile"
}

func executeProfile(ctx context.Context, req Request, profileName string, deps Dependencies, sink *eventSink, sleeper Sleeper, jitter JitterFn, runner ChildRunner, stderr interfaceWriter) profileOutcome {
	var outcome profileOutcome
	outcome.summary.Profile = profileName
	currentNativeID := strings.TrimSpace(req.ResumeID)
	if !validNativeSessionID(currentNativeID) {
		currentNativeID = ""
	}
	var previousDialect catalog.Dialect
	for attempt := 1; attempt <= 11; attempt++ {
		if err := ctx.Err(); err != nil {
			outcome.classification = ClassificationNonRetryable
			outcome.terminal = true
			outcome.result = ChildResult{Status: "failed", ExitCode: 1, Error: err.Error()}
			return outcome
		}

		retry := attempt - 1
		resumeID := ""
		mode := "initial"
		if attempt == 1 {
			resumeID = strings.TrimSpace(req.ResumeID)
		} else if validNativeSessionID(currentNativeID) && supportsNativeResume(previousDialect) {
			resumeID = currentNativeID
			mode = "resume"
		} else {
			mode = "fresh"
		}

		attemptReq := req
		attemptReq.Selector = "profile"
		attemptReq.ProfileName = profileName
		attemptReq.PolicyName = ""
		attemptReq.PolicyCandidates = nil
		attemptReq.ResumeID = resumeID
		plan, clientFamily, err := Prepare(attemptReq, deps)
		if err != nil {
			outcome.classification = ClassificationNonRetryable
			outcome.terminal = true
			outcome.result = ChildResult{Status: "failed", ExitCode: 1, Error: err.Error(), ClientFamily: clientFamily}
			return outcome
		}
		if len(plan.Command) == 0 {
			outcome.classification = ClassificationNonRetryable
			outcome.terminal = true
			outcome.result = ChildResult{Status: "failed", ExitCode: 1, Error: fmt.Sprintf("forge: empty command for profile %s", profileName), ClientFamily: clientFamily}
			return outcome
		}
		previousDialect = plan.Dialect
		if attempt > 1 && mode == "resume" && !supportsNativeResume(plan.Dialect) {
			mode = "fresh"
			resumeID = ""
			attemptReq.ResumeID = ""
			plan, clientFamily, err = Prepare(attemptReq, deps)
			if err != nil {
				outcome.classification = ClassificationNonRetryable
				outcome.terminal = true
				outcome.result = ChildResult{Status: "failed", ExitCode: 1, Error: err.Error(), ClientFamily: clientFamily}
				return outcome
			}
		}
		if req.Format == protocol.OutputFormatStreamJSON {
			attemptStarted := map[string]any{
				"attempt": attempt, "profile": profileName, "retry": retry, "mode": mode,
			}
			if clientFamily != "" {
				attemptStarted["client_family"] = clientFamily
			}
			// Additive concrete adapter identity (e.g. codebuddy) alongside the
			// compatibility public client_family (claude for CodeBuddy).
			if concrete := strings.TrimSpace(plan.TranscriptFamily); concrete != "" {
				attemptStarted["client"] = concrete
			}
			sink.emit(protocol.EventAttemptStarted, attemptStarted)
		}
		outcome.summary.Attempts++
		if retry > 0 {
			outcome.summary.Retries++
			if mode == "resume" {
				outcome.summary.ResumeAttempts++
			} else {
				outcome.summary.FreshAttempts++
			}
		}

		sink.beginAttempt()
		child := runner(ctx, AttemptRequest{
			Plan: plan, Profile: profileName, Prompt: req.Prompt, ResumeID: resumeID,
			ClientFamily: clientFamily, Attempt: attempt, Retry: retry, Mode: mode, Context: ctx,
			sink: sink, stderr: stderr,
		})
		if child.ClientFamily == "" {
			child.ClientFamily = clientFamily
		}
		if !child.EventsEmitted {
			for _, event := range child.Events {
				sink.handleNormalizedEvent(event)
			}
		}
		events := child.Events
		if child.EventsEmitted || sink.failedValidation() {
			events = sink.attemptSnapshot()
		}
		if strings.TrimSpace(child.Error) == "" {
			child.Error = normalizedFailureMessage(events)
		}
		var childError bool
		child, childError = enforceChildError(child)
		if cleanupErr := cleanupCompletedResources(plan.Resources); cleanupErr != nil {
			child.Status = "failed"
			if child.ExitCode == 0 {
				child.ExitCode = 1
			}
			if strings.TrimSpace(child.Error) == "" {
				child.Error = cleanupErr.Error()
			}
			outcome.classification = ClassificationNonRetryable
			outcome.result = child
			outcome.terminal = true
			return outcome
		}
		nativeTerminalSuccess := validNormalizedTerminalSuccess(events)
		var invalidGrokSuccess bool
		child, invalidGrokSuccess = enforceGrokNativeStreamResult(clientFamily, child)
		if !hasRunFinishedEvent(events) {
			status := child.Status
			if status == "" {
				status = "failed"
			}
			events = append(events, protocol.Event{Type: protocol.EventRunFinished, Data: map[string]any{"status": status, "exit_code": child.ExitCode}})
		}
		observedNativeID := ""
		if validNativeSessionID(child.NativeSessionID) {
			observedNativeID = strings.TrimSpace(child.NativeSessionID)
		}
		if fromEvents := latestNativeSessionID(events); fromEvents != "" {
			observedNativeID = fromEvents
		}
		if clientFamily == "grok" && validNativeSessionID(observedNativeID) {
			// Grok 0.2.106 omits tool calls from streaming-json stdout but
			// records use_tool calls in the current native chat history. Recover
			// them before a successful run removes its isolated Home. Extraction
			// is deliberately best-effort: missing or malformed native state must
			// not change the child result.
			if calls, recoverErr := grok.CurrentTurnToolCalls(plan.ConfigDir, observedNativeID); recoverErr == nil {
				for _, call := range calls {
					event := protocol.Event{Type: "tool_call", Data: map[string]any{
						"name": call.Name, "call_id": call.CallID, "input_summary": call.InputSummary,
					}}
					sink.handleNormalizedEvent(event)
					events = insertBeforeRunFinished(events, event)
				}
				child.Events = append([]protocol.Event(nil), events...)
			}
		}
		classification := ClassifyAttempt(events, depsClock(deps).Now())
		outcome.classification = classification.Classification
		if invalidGrokSuccess || childError && outcome.classification == ClassificationNone {
			outcome.classification = ClassificationNonRetryable
		}
		outcome.recoveryAt = classification.RecoveryAt
		if classification.NativeSessionID != "" {
			observedNativeID = classification.NativeSessionID
		}
		if clientFamily != "grok" {
			if validNativeSessionID(observedNativeID) {
				currentNativeID = observedNativeID
			}
			child.NativeSessionID = currentNativeID
		} else {
			trust := classifyGrokAttemptTrust(child, childError)
			snapshotID := observedNativeID
			if !validNativeSessionID(snapshotID) {
				snapshotID = currentNativeID
			}
			refreshEligible := trust == driver.GrokTrustCompleteSuccess && nativeTerminalSuccess ||
				trust == driver.GrokTrustCompleteNativeFailure &&
					classification.Classification != ClassificationNone && classification.Classification != ClassificationNonRetryable
			if refreshEligible && validNativeSessionID(snapshotID) {
				if snapshotErr := grok.RefreshNativeSessionSnapshot(deps.DataDir, plan.ConfigDir, snapshotID); snapshotErr != nil {
					child.Status = "failed"
					if child.ExitCode == 0 {
						child.ExitCode = 1
					}
					if strings.TrimSpace(child.Error) == "" {
						child.Error = snapshotErr.Error()
					} else {
						child.Error = child.Error + "; " + snapshotErr.Error()
					}
					outcome.classification = ClassificationNonRetryable
					outcome.result = child
					outcome.terminal = true
					return outcome
				}
				currentNativeID = snapshotID
			}
			child.NativeSessionID = currentNativeID
		}
		if child.Status == "done" && child.ExitCode == 0 && classification.Classification == ClassificationNone {
			cleanupEligible := nativeTerminalSuccess
			if clientFamily == "grok" {
				cleanupEligible = child.GrokStream.IsValid()
			} else if clientFamily == "codex" {
				// Codex JSONL has no explicit successful terminal record. A
				// clean process plus both assistant output and turn usage is its
				// complete-success evidence; empty or truncated streams retain
				// per-run resources for diagnosis.
				cleanupEligible = hasCodexSuccessEvidence(events)
			} else if clientFamily == "opencode" {
				// OpenCode's JSON stream has no terminal record; a clean process
				// exit plus normalized message/usage evidence is its successful
				// completion contract. Empty or malformed zero-exit streams retain
				// RemoveOnSuccess resources for diagnosis.
				cleanupEligible = hasOpenCodeSuccessEvidence(events)
			} else if clientFamily == "dsh" {
				// DSH's forge.dsh.stream.v1 JSONL has no explicit terminal
				// record; a clean process plus normalized message/usage evidence
				// is its complete-success contract. Empty or malformed streams
				// retain per-run DSH_HOME resources for diagnosis.
				cleanupEligible = hasDSHSuccessEvidence(events)
			}
			if cleanupEligible {
				if cleanupErr := cleanupSuccessfulResources(plan.Resources); cleanupErr != nil {
					child.Status = "failed"
					child.ExitCode = 1
					child.Error = cleanupErr.Error()
					outcome.classification = ClassificationNonRetryable
					outcome.result = child
					outcome.terminal = true
					return outcome
				}
			}
			outcome.result = child
			outcome.terminal = true
			return outcome
		}
		if outcome.classification == ClassificationNonRetryable || outcome.classification == ClassificationNone {
			outcome.result = child
			outcome.terminal = true
			return outcome
		}

		if req.Format == protocol.OutputFormatStreamJSON {
			sink.emit(protocol.EventAttemptFinished, map[string]any{
				"attempt": attempt, "profile": profileName, "status": child.Status,
				"exit_code": child.ExitCode, "classification": string(classification.Classification), "terminal": false,
			})
		}
		if classification.ImmediateCircuit {
			now := clockFor(deps).Now()
			record := makeCircuitRecord(profileName, classification.Classification, CircuitReasonHardProfileLimit, retry, now, now.Add(time.Hour))
			persisted := NewCircuitStore(deps.StateRoot, clockFor(deps)).Write(profileName, record)
			outcome.circuit = &record
			outcome.result = child
			if req.Format == protocol.OutputFormatStreamJSON {
				sink.emit(protocol.EventCircuitOpened, circuitOpenedData(profileName, record, persisted))
			}
			return outcome
		}
		if classification.RecoveryAt != nil {
			record := makeCircuitRecord(profileName, classification.Classification, CircuitReasonStructuredRecovery, retry, clockFor(deps).Now(), *classification.RecoveryAt)
			persisted := NewCircuitStore(deps.StateRoot, clockFor(deps)).Write(profileName, record)
			outcome.circuit = &record
			outcome.result = child
			if req.Format == protocol.OutputFormatStreamJSON {
				sink.emit(protocol.EventCircuitOpened, circuitOpenedData(profileName, record, persisted))
			}
			return outcome
		}
		if retry >= maxProfileRetries {
			now := clockFor(deps).Now()
			record := makeCircuitRecord(profileName, classification.Classification, CircuitReasonRetryExhausted, maxProfileRetries, now, now.Add(time.Hour))
			persisted := NewCircuitStore(deps.StateRoot, clockFor(deps)).Write(profileName, record)
			outcome.circuit = &record
			outcome.result = child
			if req.Format == protocol.OutputFormatStreamJSON {
				sink.emit(protocol.EventCircuitOpened, circuitOpenedData(profileName, record, persisted))
			}
			return outcome
		}

		nextRetry := retry + 1
		delay := retryDelay(nextRetry, jitter)
		nextMode := "fresh"
		if validNativeSessionID(currentNativeID) && supportsNativeResume(plan.Dialect) {
			nextMode = "resume"
		}
		if req.Format == protocol.OutputFormatStreamJSON {
			sink.emit(protocol.EventRetryScheduled, map[string]any{
				"profile": profileName, "retry": nextRetry, "delay_ms": delay.Milliseconds(), "mode": nextMode,
			})
		}
		if delay > 0 {
			if err := sleeper.Sleep(delay); err != nil {
				outcome.classification = ClassificationNonRetryable
				outcome.terminal = true
				outcome.result = ChildResult{Status: "failed", ExitCode: 1, Error: err.Error(), NativeSessionID: currentNativeID, ClientFamily: clientFamily}
				return outcome
			}
		}
	}
	return outcome
}

func insertBeforeRunFinished(events []protocol.Event, recovered protocol.Event) []protocol.Event {
	index := len(events)
	for i, event := range events {
		if event.Type == protocol.EventRunFinished {
			index = i
			break
		}
	}
	events = append(events, protocol.Event{})
	copy(events[index+1:], events[index:])
	events[index] = recovered
	return events
}

func hasOpenCodeSuccessEvidence(events []protocol.Event) bool {
	for _, event := range events {
		if event.Type == "message" || event.Type == "turn_usage" {
			return true
		}
	}
	return false
}

// hasDSHSuccessEvidence reports whether a DSH invocation produced both
// assistant output and a turn_usage record. DSH's stream carries no explicit
// successful terminal record, so a clean process plus both pieces of evidence
// is its complete-success contract; empty or truncated streams retain per-run
// DSH_HOME resources for diagnosis.
func hasDSHSuccessEvidence(events []protocol.Event) bool {
	message := false
	usage := false
	for _, event := range events {
		switch event.Type {
		case "message":
			message = true
		case "turn_usage":
			usage = true
		}
	}
	return message && usage
}

func hasCodexSuccessEvidence(events []protocol.Event) bool {
	message := false
	usage := false
	for _, event := range events {
		switch event.Type {
		case "message":
			message = true
		case "turn_usage":
			usage = true
		}
	}
	return message && usage
}

func enforceGrokNativeStreamResult(clientFamily string, child ChildResult) (ChildResult, bool) {
	if clientFamily != "grok" || child.Status != "done" || child.ExitCode != 0 || child.GrokStream.IsValid() {
		return child, false
	}
	child.Status = "failed"
	child.ExitCode = 1
	child.Error = invalidGrokNativeOutputError
	return child, true
}

func classifyGrokAttemptTrust(child ChildResult, childError bool) driver.GrokAttemptTrust {
	if child.Status == "cancelled" || child.GrokStream.Trust == driver.GrokTrustCancelled {
		return driver.GrokTrustCancelled
	}
	if child.ProcessError || child.GrokStream.IsValid() && (childError || child.Status != "done" || child.ExitCode != 0) {
		return driver.GrokTrustChildProcessError
	}
	if !child.GrokStream.Checked {
		return driver.GrokTrustInvalidOrIncomplete
	}
	return child.GrokStream.Trust
}

func supportsNativeResume(dialect catalog.Dialect) bool {
	return dialect == catalog.DialectClaudeCode || dialect == catalog.DialectCodeBuddy || dialect == catalog.DialectCodex || dialect == catalog.DialectOpenCode || dialect == catalog.DialectGrok
}

func clockFor(deps Dependencies) Clock {
	if deps.Clock != nil {
		return deps.Clock
	}
	return realClock{}
}

func depsClock(deps Dependencies) Clock { return clockFor(deps) }

func hasRunFinishedEvent(events []protocol.Event) bool {
	for _, event := range events {
		if event.Type == protocol.EventRunFinished {
			return true
		}
	}
	return false
}

func validNormalizedTerminalSuccess(events []protocol.Event) bool {
	terminalIndex := -1
	terminalCount := 0
	for i, event := range events {
		if event.Type != protocol.EventRunFinished {
			continue
		}
		terminalCount++
		terminalIndex = i
		if event.Data == nil {
			return false
		}
		status, ok := event.Data["status"].(string)
		if !ok || !strings.EqualFold(strings.TrimSpace(status), "done") {
			return false
		}
	}
	return terminalCount == 1 && terminalIndex == len(events)-1
}

func normalizedFailureMessage(events []protocol.Event) string {
	for i := len(events) - 1; i >= 0; i-- {
		if events[i].Type != protocol.EventRunFinished || events[i].Data == nil {
			continue
		}
		if message := normalizedText(events[i].Data["error"]); strings.TrimSpace(message) != "" {
			return strings.TrimSpace(message)
		}
	}
	return ""
}

func makeCircuitRecord(profile string, classification Classification, reason string, retryCount int, opened, unlock time.Time) CircuitRecord {
	opened = opened.UTC().Truncate(time.Second)
	unlock = unlock.UTC()
	if remainder := unlock.Nanosecond(); remainder != 0 {
		unlock = unlock.Add(time.Second - time.Duration(remainder))
	}
	return CircuitRecord{
		SchemaVersion: circuitSchemaVersion,
		ProfileHash:   profileHash(profile), State: CircuitStateOpen,
		OpenedAt: opened.UTC().Format(time.RFC3339), UnlockAt: unlock.UTC().Format(time.RFC3339),
		Classification: classification, ReasonCode: reason, RetryCount: retryCount,
	}
}

func circuitOpenedData(profile string, record CircuitRecord, persisted bool) map[string]any {
	return map[string]any{
		"profile": profile, "unlock_at": record.UnlockAt, "classification": string(record.Classification),
		"reason_code": record.ReasonCode, "retry_count": record.RetryCount, "persisted": persisted,
	}
}

func addCircuitObservation(profile string, record *CircuitRecord, profiles *[]string, unlocks map[string]string) {
	if record == nil {
		return
	}
	for _, existing := range *profiles {
		if existing == profile {
			unlocks[profile] = record.UnlockAt
			return
		}
	}
	*profiles = append(*profiles, profile)
	unlocks[profile] = record.UnlockAt
}

func emitPolicyFallback(sink *eventSink, from, to, reason, unlock string) {
	if !sink.stream {
		return
	}
	data := map[string]any{"from_profile": nil, "to_profile": nil, "reason": reason}
	if from != "" {
		data["from_profile"] = from
	}
	if to != "" {
		data["to_profile"] = to
	}
	if unlock != "" {
		data["unlock_at"] = unlock
	}
	sink.emit(protocol.EventPolicyFallback, data)
}

func successResult(req Request, profile string, child ChildResult, summaries []protocol.AttemptSummary, profiles []string, unlocks map[string]string, sink *eventSink) Result {
	result := sink.resultSnapshot()
	result.Status = "done"
	result.Profile = profile
	result.ExitCode = 0
	result.Error = ""
	result.FailureClass = ""
	result.Attempts = append([]protocol.AttemptSummary(nil), summaries...)
	result.CircuitProfiles = append([]string(nil), profiles...)
	result.CircuitUnlockAt = copyStringMap(unlocks)
	if child.Summary != "" {
		result.Summary = child.Summary
	}
	if child.Usage != nil {
		result.Usage = child.Usage
	}
	if child.NativeSessionID != "" {
		result.NativeSessionID = child.NativeSessionID
	}
	if child.ClientFamily != "" {
		result.ClientFamily = child.ClientFamily
	}
	return result
}

func failedAttemptResult(req Request, profile string, outcome profileOutcome, summaries []protocol.AttemptSummary, profiles []string, unlocks map[string]string, sink *eventSink) Result {
	result := sink.resultSnapshot()
	result.Status = "failed"
	result.Profile = profile
	result.ExitCode = outcome.result.ExitCode
	if result.ExitCode == 0 {
		result.ExitCode = 1
	}
	result.FailureClass = string(outcome.classification)
	result.Error = safeChildError(outcome.result)
	result.Attempts = append([]protocol.AttemptSummary(nil), summaries...)
	result.CircuitProfiles = append([]string(nil), profiles...)
	result.CircuitUnlockAt = copyStringMap(unlocks)
	if outcome.result.Summary != "" {
		result.Summary = outcome.result.Summary
	}
	if outcome.result.NativeSessionID != "" {
		result.NativeSessionID = outcome.result.NativeSessionID
	}
	if outcome.result.ClientFamily != "" {
		result.ClientFamily = outcome.result.ClientFamily
	}
	return result
}

func failureResult(req Request, profile string, classification FailureClass, message string, summaries []protocol.AttemptSummary, profiles []string, unlocks map[string]string) Result {
	return Result{Status: "failed", Profile: profile, FailureClass: string(classification), Error: message, ExitCode: 1,
		Attempts: append([]protocol.AttemptSummary(nil), summaries...), CircuitProfiles: append([]string(nil), profiles...), CircuitUnlockAt: copyStringMap(unlocks)}
}

func safeChildError(child ChildResult) string {
	if strings.TrimSpace(child.Error) != "" {
		return child.Error
	}
	return "runtime attempt failed"
}

func terminalError(result Result) error {
	if strings.TrimSpace(result.Error) != "" {
		return fmt.Errorf("%s", result.Error)
	}
	if result.FailureClass != "" {
		return fmt.Errorf("runtime failed: %s", result.FailureClass)
	}
	return fmt.Errorf("runtime failed")
}

func finalEventData(result Result) map[string]any {
	data := map[string]any{"status": result.Status, "exit_code": result.ExitCode, "terminal": true}
	for key, value := range resultJSONData(result) {
		data[key] = value
	}
	return data
}

func resultJSONData(result Result) map[string]any {
	data := map[string]any{}
	if result.Profile != "" {
		data["profile"] = result.Profile
	}
	if result.ClientFamily != "" {
		data["client_family"] = result.ClientFamily
	}
	if result.NativeSessionID != "" {
		data["native_session_id"] = result.NativeSessionID
	}
	if result.Summary != "" {
		data["summary"] = result.Summary
	}
	if result.Usage != nil {
		data["usage"] = copyEventData(result.Usage)
	}
	if result.Error != "" {
		data["error"] = result.Error
	}
	if result.FailureClass != "" {
		data["failure_class"] = result.FailureClass
	}
	if len(result.CircuitProfiles) > 0 {
		data["circuit_profiles"] = result.CircuitProfiles
	}
	if len(result.CircuitUnlockAt) > 0 {
		data["circuit_unlock_at"] = result.CircuitUnlockAt
	}
	if len(result.Attempts) > 0 {
		data["attempts"] = result.Attempts
	}
	return data
}

func copyStringMap(in map[string]string) map[string]string {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]string, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}

func nextCandidate(candidates []string, index int) string {
	if index+1 >= len(candidates) {
		return ""
	}
	return candidates[index+1]
}

func lastOr(values []string) string {
	if len(values) == 0 {
		return ""
	}
	return values[len(values)-1]
}
