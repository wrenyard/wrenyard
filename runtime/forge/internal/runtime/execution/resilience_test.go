package execution

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/grok"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/driver"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/profile"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/protocol"
)

type recordingSleeper struct {
	clock  *testClock
	delays []time.Duration
}

func (s *recordingSleeper) Sleep(delay time.Duration) error {
	s.delays = append(s.delays, delay)
	s.clock.Set(s.clock.Now().Add(delay))
	return nil
}

func codexResilienceDeps(t *testing.T, clock *testClock, runner ChildRunner) Dependencies {
	t.Helper()
	return clientResilienceDeps(t, clock, runner, "codex", "CODEX_AUTH_TOKEN")
}

// clientResilienceDeps builds deterministic execution dependencies for a given
// concrete native client so lifecycle-metadata tests can cover CodeBuddy
// (client=codebuddy, public client_family=claude) alongside Codex.
func clientResilienceDeps(t *testing.T, clock *testClock, runner ChildRunner, client, credentialEnv string) Dependencies {
	t.Helper()
	d := newFakeDeps(t)
	d.loadProfile = func(name string) (ProfileDefinition, bool, error) {
		return ProfileDefinition{Name: name, Client: client}, true, nil
	}
	d.resolveProfile = func(def ProfileDefinition) (profile.ResolvedProfile, error) {
		return profile.ResolvedProfile{
			Name: def.Name, Client: catalog.Client{}, Provider: catalog.Provider{},
			Compatibility: profile.CompatibilityClientUnregistered,
			Credential:    profile.CredentialPlan{TargetEnv: credentialEnv},
		}, nil
	}
	d.Dependencies.Clock = clock
	d.Dependencies.StateRoot = t.TempDir()
	d.Dependencies.JitterFn = func(time.Duration) time.Duration { return 0 }
	d.Dependencies.Runner = runner
	return d.Dependencies
}

func retryableEvent(class FailureClass, extra map[string]any) []protocol.Event {
	data := map[string]any{"status": "failed", "failure_class": string(class), "error": "provider failure"}
	for key, value := range extra {
		data[key] = value
	}
	return []protocol.Event{{Type: protocol.EventRunFinished, Data: data}}
}

func doneEvent(text string) []protocol.Event {
	return []protocol.Event{
		{Type: "message", Data: map[string]any{"text": text}},
		{Type: protocol.EventRunFinished, Data: map[string]any{"status": "done"}},
	}
}

func invalidGrokStream() driver.GrokStreamValidity {
	return driver.GrokStreamValidity{Checked: true, Trust: driver.GrokTrustInvalidOrIncomplete}
}

func writeExecutionNativeSession(t *testing.T, home, nativeID, cwd, state string) {
	t.Helper()
	sessionDir := filepath.Join(home, "sessions", "encoded-workspace", nativeID)
	if err := os.MkdirAll(sessionDir, 0o700); err != nil {
		t.Fatal(err)
	}
	summary, err := json.Marshal(map[string]any{"info": map[string]string{"id": nativeID, "cwd": cwd}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sessionDir, "summary.json"), summary, 0o600); err != nil {
		t.Fatal(err)
	}
	update, err := json.Marshal(map[string]string{"type": "execution_test_state", "state": state})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sessionDir, "updates.jsonl"), append(update, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	chat, err := json.Marshal(map[string]string{"role": "user", "content": state})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sessionDir, "chat_history.jsonl"), append(chat, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
}

func findExecutionNativeSession(home, nativeID string) (string, error) {
	var found string
	err := filepath.WalkDir(filepath.Join(home, "sessions"), func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() && entry.Name() == nativeID {
			if found != "" {
				return errors.New("ambiguous native session")
			}
			found = path
			return filepath.SkipDir
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	if found == "" {
		return "", errors.New("native session not found")
	}
	return found, nil
}

func readExecutionNativeState(t *testing.T, sessionDir string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(sessionDir, "updates.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	var update map[string]string
	if err := json.Unmarshal(data, &update); err != nil {
		t.Fatal(err)
	}
	return update["state"]
}

func overwriteExecutionGrokToolHistory(t *testing.T, home, nativeID string, records ...map[string]any) {
	t.Helper()
	sessionDir, err := findExecutionNativeSession(home, nativeID)
	if err != nil {
		t.Fatal(err)
	}
	var history bytes.Buffer
	for _, record := range records {
		data, err := json.Marshal(record)
		if err != nil {
			t.Fatal(err)
		}
		history.Write(data)
		history.WriteByte('\n')
	}
	if err := os.WriteFile(filepath.Join(sessionDir, "chat_history.jsonl"), history.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
}

func executionGrokUseTool(t *testing.T, id, name string, input any) map[string]any {
	t.Helper()
	arguments, err := json.Marshal(map[string]any{"tool_name": name, "tool_input": input})
	if err != nil {
		t.Fatal(err)
	}
	return map[string]any{"id": id, "name": "use_tool", "arguments": string(arguments)}
}

func findExecutionNativeSessionFile(t *testing.T, root, nativeID, name string) string {
	t.Helper()
	sessionDir, err := findExecutionNativeSession(root, nativeID)
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Join(sessionDir, name)
}

func grokResilienceDeps(t *testing.T, runner ChildRunner) (Dependencies, *[]string) {
	t.Helper()
	d := newFakeDeps(t)
	parent := filepath.Join(t.TempDir(), "agent-grok")
	d.loadProfile = func(name string) (ProfileDefinition, bool, error) {
		return ProfileDefinition{
			Name: name, Client: "grok", Provider: "zhipu-coding",
			Env: map[string]string{"GROK_MODEL": "forge-zhipu-coding--glm-5-3"},
		}, true, nil
	}
	d.resolveProfile = func(def ProfileDefinition) (profile.ResolvedProfile, error) {
		return profile.ResolvedProfile{
			Name: def.Name,
			Client: catalog.Client{
				Name: "grok", Dialect: catalog.DialectGrok, Binary: catalog.BinarySpec{Name: "go"},
				PermissionAdapter: catalog.PermissionAdapterGrok, ResumeFlag: "--resume",
			},
			Compatibility: profile.CompatibilityNone,
		}, nil
	}
	d.Dependencies.PrepareRuntime = func(ProfileDefinition, profile.ResolvedProfile) (driver.RuntimePreparation, error) {
		return driver.RuntimePreparation{
			HomeParent: parent, HomeEnvVar: "GROK_HOME",
			Files: []driver.PreparedFile{{RelativePath: "config.toml", Data: []byte("[model.test]\nmodel = \"test\"\n"), Mode: 0o600}},
		}, nil
	}
	d.Dependencies.JitterFn = func(time.Duration) time.Duration { return 0 }
	d.Dependencies.StateRoot = t.TempDir()
	homes := []string{}
	d.Dependencies.Runner = func(ctx context.Context, request AttemptRequest) ChildResult {
		homes = append(homes, request.Plan.ConfigDir)
		return runner(ctx, request)
	}
	return d.Dependencies, &homes
}

func TestExecuteSameProfileRetriesResumeAndPreservesPrompt(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 7, 12, 6, 30, 0, 0, time.UTC)}
	sleeper := &recordingSleeper{clock: clock}
	var calls []AttemptRequest
	deps := codexResilienceDeps(t, clock, func(_ context.Context, request AttemptRequest) ChildResult {
		calls = append(calls, request)
		switch request.Attempt {
		case 1:
			return ChildResult{Status: "failed", ExitCode: 1, NativeSessionID: "thread-1", Events: retryableEvent(FailureClassTransientProvider, nil)}
		case 2:
			return ChildResult{Status: "failed", ExitCode: 1, NativeSessionID: "thread-2", Events: retryableEvent(FailureClassTransientProvider, nil)}
		default:
			return ChildResult{Status: "done", ExitCode: 0, NativeSessionID: "thread-3", Summary: "ok", Events: doneEvent("ok")}
		}
	})
	deps.Sleeper = sleeper
	req := Request{Selector: "profile", ProfileName: "exact", Prompt: "429 is only prompt text", WorkDir: tempDir(t), Format: protocol.OutputFormatJSON}
	got, err := Execute(req, deps, &bytes.Buffer{}, &bytes.Buffer{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Status != "done" || got.Summary != "ok" {
		t.Fatalf("result=%+v want success", got)
	}
	if len(calls) != 3 {
		t.Fatalf("attempt count=%d want 3", len(calls))
	}
	profiles := make([]string, len(calls))
	resumes := make([]string, len(calls))
	for i, call := range calls {
		profiles[i], resumes[i] = call.Profile, call.ResumeID
		if call.Prompt != req.Prompt {
			t.Fatalf("attempt %d prompt=%q want original %q", i+1, call.Prompt, req.Prompt)
		}
	}
	if !reflect.DeepEqual(profiles, []string{"exact", "exact", "exact"}) {
		t.Fatalf("profiles=%v", profiles)
	}
	if !reflect.DeepEqual(resumes, []string{"", "thread-1", "thread-2"}) {
		t.Fatalf("resume ids=%v", resumes)
	}
	if !reflect.DeepEqual(sleeper.delays, []time.Duration{2 * time.Second}) {
		t.Fatalf("sleep delays=%v want [2s]", sleeper.delays)
	}
	if got.Attempts[0].ResumeAttempts != 2 || got.Attempts[0].FreshAttempts != 0 || got.Attempts[0].Retries != 2 {
		t.Fatalf("attempt summary=%+v", got.Attempts[0])
	}
}

func TestOpenCodeDialectParticipatesInNativeResume(t *testing.T) {
	if !supportsNativeResume(catalog.DialectOpenCode) {
		t.Fatal("OpenCode session IDs must be eligible for native retry resume")
	}
}

func TestRetryableGrokAttemptRetainsHomeUntilFinalNativeSuccess(t *testing.T) {
	deps, homes := grokResilienceDeps(t, func(_ context.Context, request AttemptRequest) ChildResult {
		if request.Attempt == 1 {
			return ChildResult{Status: "failed", ExitCode: 1, Events: retryableEvent(FailureClassTransientProvider, nil)}
		}
		return ChildResult{
			Status: "done", ExitCode: 0, Events: doneEvent("ok"),
			GrokStream: driver.GrokStreamValidity{Checked: true, Trust: driver.GrokTrustCompleteSuccess},
		}
	})

	result, err := Execute(Request{ProfileName: "gk", Prompt: "keep homes safe", WorkDir: tempDir(t)}, deps, &bytes.Buffer{}, &bytes.Buffer{})
	if err != nil || result.Status != "done" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	if len(*homes) != 2 {
		t.Fatalf("attempt homes = %v, want two", *homes)
	}
	if _, err := os.Stat((*homes)[0]); err != nil {
		t.Fatalf("retryable non-final attempt Home was removed: %v", err)
	}
	if _, err := os.Stat((*homes)[1]); !os.IsNotExist(err) {
		t.Fatalf("final valid terminal success Home still exists: %v", err)
	}
}

func TestRetryableGrokAttemptSnapshotsRestoresAndRefreshesNativeSession(t *testing.T) {
	nativeID := "retry-native-session"
	deps, homes := grokResilienceDeps(t, func(_ context.Context, request AttemptRequest) ChildResult {
		switch request.Attempt {
		case 1:
			writeExecutionNativeSession(t, request.Plan.ConfigDir, nativeID, request.Plan.WorkDir, "attempt-one")
			return ChildResult{
				Status: "done", ExitCode: 0, NativeSessionID: nativeID,
				Events:     retryableEvent(FailureClassTransientProvider, nil),
				GrokStream: driver.GrokStreamValidity{Checked: true, Trust: driver.GrokTrustCompleteNativeFailure},
			}
		case 2:
			if request.ResumeID != nativeID || request.Mode != "resume" {
				t.Fatalf("retry request did not carry native resume: %+v", request)
			}
			location, err := findExecutionNativeSession(request.Plan.ConfigDir, nativeID)
			if err != nil {
				t.Fatalf("retry Home did not contain restored native state: %v", err)
			}
			if state := readExecutionNativeState(t, location); state != "attempt-one" {
				t.Fatalf("retry restored state = %q, want attempt-one", state)
			}
			writeExecutionNativeSession(t, request.Plan.ConfigDir, nativeID, request.Plan.WorkDir, "attempt-two")
			return ChildResult{
				Status: "done", ExitCode: 0, NativeSessionID: nativeID, Events: doneEvent("ok"),
				GrokStream: driver.GrokStreamValidity{Checked: true, Trust: driver.GrokTrustCompleteSuccess},
			}
		default:
			t.Fatalf("unexpected Grok attempt %d", request.Attempt)
			return ChildResult{}
		}
	})

	result, err := Execute(Request{ProfileName: "gk", Prompt: "resume failed attempt", WorkDir: tempDir(t)}, deps, &bytes.Buffer{}, &bytes.Buffer{})
	if err != nil || result.Status != "done" || result.NativeSessionID != nativeID {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	if len(*homes) != 2 || (*homes)[0] == (*homes)[1] {
		t.Fatalf("retry Homes = %v, want two unique Homes", *homes)
	}
	if _, statErr := os.Stat((*homes)[0]); statErr != nil {
		t.Fatalf("failed attempt Home was not retained: %v", statErr)
	}
	if _, statErr := os.Stat((*homes)[1]); !os.IsNotExist(statErr) {
		t.Fatalf("successful retry Home was not removed: %v", statErr)
	}
	restoredHome := t.TempDir()
	if err := grok.RestoreNativeSessionSnapshot(deps.DataDir, restoredHome, nativeID); err != nil {
		t.Fatal(err)
	}
	location, err := findExecutionNativeSession(restoredHome, nativeID)
	if err != nil {
		t.Fatal(err)
	}
	if state := readExecutionNativeState(t, location); state != "attempt-two" {
		t.Fatalf("refreshed retry snapshot state = %q, want attempt-two", state)
	}
}

func TestExecuteGrokEmitsRecoveredCurrentTurnToolCallBeforeHomeCleanup(t *testing.T) {
	nativeID := "grok-tool-call-native"
	privateReasoning := "PRIVATE_GROK_REASONING_MUST_NOT_ESCAPE"
	deps, homes := grokResilienceDeps(t, func(_ context.Context, request AttemptRequest) ChildResult {
		writeExecutionNativeSession(t, request.Plan.ConfigDir, nativeID, request.Plan.WorkDir, "tool-call-state")
		overwriteExecutionGrokToolHistory(t, request.Plan.ConfigDir, nativeID,
			map[string]any{"type": "user", "content": "prompt", "prompt_index": 0},
			map[string]any{"type": "reasoning", "content": privateReasoning},
			map[string]any{"type": "assistant", "tool_calls": []any{
				map[string]any{"id": "native-search", "name": "search_tool", "arguments": `{"query":"ignored"}`},
				executionGrokUseTool(t, "native-use-tool", "ure__ure_probe", map[string]any{"query": "probe"}),
			}},
			map[string]any{"type": "assistant", "content": "done"},
		)
		return ChildResult{
			Status: "done", ExitCode: 0, NativeSessionID: nativeID, Events: doneEvent("ok"),
			GrokStream: driver.GrokStreamValidity{Checked: true, Trust: driver.GrokTrustCompleteSuccess},
		}
	})

	var out bytes.Buffer
	result, err := Execute(Request{
		ProfileName: "gk", Prompt: "use the MCP tool", WorkDir: tempDir(t), Format: protocol.OutputFormatStreamJSON,
	}, deps, &out, &bytes.Buffer{})
	if err != nil || result.Status != "done" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	if len(*homes) != 1 {
		t.Fatalf("homes=%v", *homes)
	}
	if _, statErr := os.Stat((*homes)[0]); !os.IsNotExist(statErr) {
		t.Fatalf("successful Grok Home was not cleaned after recovery: %v", statErr)
	}

	var recovered []protocol.Envelope
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		var envelope protocol.Envelope
		if err := json.Unmarshal([]byte(line), &envelope); err != nil {
			t.Fatal(err)
		}
		if envelope.Type == "tool_call" {
			recovered = append(recovered, envelope)
		}
	}
	if len(recovered) != 1 {
		t.Fatalf("tool_call envelopes=%+v; stream=%s", recovered, out.String())
	}
	data := recovered[0].Data
	if data["name"] != "ure__ure_probe" || data["call_id"] != "native-use-tool" || data["input_summary"] != `{"query":"probe"}` {
		t.Fatalf("recovered tool_call=%+v", data)
	}
	if strings.Contains(out.String(), privateReasoning) || strings.Contains(out.String(), "native-search") {
		t.Fatalf("stream exposed reasoning or search_tool: %s", out.String())
	}
}

func TestExecuteGrokToolCallRecoveryFailureDoesNotChangeSuccessfulRun(t *testing.T) {
	deps, homes := grokResilienceDeps(t, func(_ context.Context, _ AttemptRequest) ChildResult {
		// A native id without a session subtree forces best-effort recovery to
		// fail. The intentionally absent native terminal also keeps this test
		// independent from durable resume snapshot validation.
		return ChildResult{
			Status: "done", ExitCode: 0, NativeSessionID: "missing-native-history",
			Events:     []protocol.Event{{Type: "message", Data: map[string]any{"text": "ok"}}},
			GrokStream: driver.GrokStreamValidity{Checked: true, Trust: driver.GrokTrustCompleteSuccess},
		}
	})

	var out bytes.Buffer
	result, err := Execute(Request{
		ProfileName: "gk", Prompt: "no history", WorkDir: tempDir(t), Format: protocol.OutputFormatStreamJSON,
	}, deps, &out, &bytes.Buffer{})
	if err != nil || result.Status != "done" {
		t.Fatalf("recovery failure changed run result: result=%+v err=%v stream=%s", result, err, out.String())
	}
	if len(*homes) != 1 {
		t.Fatalf("homes=%v", *homes)
	}
	if _, statErr := os.Stat((*homes)[0]); !os.IsNotExist(statErr) {
		t.Fatalf("successful Grok Home was not cleaned: %v", statErr)
	}
}

func TestGrokInitialAbnormalAttemptsNeverCreateDurableSnapshot(t *testing.T) {
	nativeID := "initial-abnormal-native-session"
	for _, tc := range []struct {
		name  string
		child ChildResult
	}{
		{name: "malformed truncated incomplete duplicate or non-final", child: ChildResult{Status: "done", NativeSessionID: nativeID, Events: doneEvent("partial"), GrokStream: invalidGrokStream()}},
		{name: "cancelled", child: ChildResult{Status: "cancelled", NativeSessionID: nativeID, Events: retryableEvent(FailureClassNonRetryable, map[string]any{"error": "Cancelled"}), GrokStream: driver.GrokStreamValidity{Checked: true, Trust: driver.GrokTrustCancelled}}},
		{name: "child process error", child: ChildResult{Status: "failed", ExitCode: 1, NativeSessionID: nativeID, Error: "child process error", ProcessError: true, Events: doneEvent("partial"), GrokStream: driver.GrokStreamValidity{Checked: true, Trust: driver.GrokTrustCompleteSuccess}}},
		{name: "start error without terminal", child: ChildResult{Status: "failed", ExitCode: 1, NativeSessionID: nativeID, Error: "start error", ProcessError: true}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			deps, homes := grokResilienceDeps(t, func(_ context.Context, request AttemptRequest) ChildResult {
				writeExecutionNativeSession(t, request.Plan.ConfigDir, nativeID, request.Plan.WorkDir, "untrusted-partial-state")
				return tc.child
			})
			result, err := Execute(Request{ProfileName: "gk", Prompt: "initial abnormal", WorkDir: tempDir(t)}, deps, &bytes.Buffer{}, &bytes.Buffer{})
			if err == nil || result.Status != "failed" || len(*homes) != 1 {
				t.Fatalf("initial abnormal result=%+v err=%v homes=%v", result, err, *homes)
			}
			if _, statErr := os.Stat((*homes)[0]); statErr != nil {
				t.Fatalf("abnormal initial attempt removed run Home: %v", statErr)
			}
			snapshot, pathErr := grok.NativeSessionSnapshotPath(deps.DataDir, nativeID)
			if pathErr != nil {
				t.Fatal(pathErr)
			}
			if _, statErr := os.Stat(snapshot); !os.IsNotExist(statErr) {
				t.Fatalf("abnormal initial attempt created durable snapshot: %v", statErr)
			}
		})
	}
}

func TestGrokResumedAbnormalAttemptsPreservePreviousSnapshotByteForByte(t *testing.T) {
	nativeID := "resumed-abnormal-native-session"
	for _, tc := range []struct {
		name  string
		child ChildResult
	}{
		{name: "malformed truncated incomplete duplicate or non-final", child: ChildResult{Status: "done", NativeSessionID: nativeID, Events: doneEvent("partial"), GrokStream: invalidGrokStream()}},
		{name: "cancelled", child: ChildResult{Status: "cancelled", NativeSessionID: nativeID, Events: retryableEvent(FailureClassNonRetryable, map[string]any{"error": "Cancelled"}), GrokStream: driver.GrokStreamValidity{Checked: true, Trust: driver.GrokTrustCancelled}}},
		{name: "child process error", child: ChildResult{Status: "failed", ExitCode: 1, NativeSessionID: nativeID, Error: "child process error", ProcessError: true, Events: doneEvent("partial"), GrokStream: driver.GrokStreamValidity{Checked: true, Trust: driver.GrokTrustCompleteSuccess}}},
		{name: "absent native terminal", child: ChildResult{Status: "failed", ExitCode: 1, NativeSessionID: nativeID, Events: retryableEvent(FailureClassNonRetryable, nil), GrokStream: invalidGrokStream()}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			deps, homes := grokResilienceDeps(t, func(_ context.Context, request AttemptRequest) ChildResult {
				location, err := findExecutionNativeSession(request.Plan.ConfigDir, nativeID)
				if err != nil || readExecutionNativeState(t, location) != "last-trusted-state" {
					t.Fatalf("resumed attempt did not restore trusted snapshot: location=%q err=%v", location, err)
				}
				writeExecutionNativeSession(t, request.Plan.ConfigDir, nativeID, request.Plan.WorkDir, "untrusted-partial-state")
				return tc.child
			})
			seedHome := t.TempDir()
			workDir := tempDir(t)
			writeExecutionNativeSession(t, seedHome, nativeID, workDir, "last-trusted-state")
			if err := grok.RefreshNativeSessionSnapshot(deps.DataDir, seedHome, nativeID); err != nil {
				t.Fatal(err)
			}
			snapshot, _ := grok.NativeSessionSnapshotPath(deps.DataDir, nativeID)
			before := snapshotTreeBytes(t, snapshot)

			result, err := Execute(Request{ProfileName: "gk", Prompt: "resumed abnormal", WorkDir: workDir, ResumeID: nativeID}, deps, &bytes.Buffer{}, &bytes.Buffer{})
			if err == nil || result.Status != "failed" || len(*homes) != 1 {
				t.Fatalf("resumed abnormal result=%+v err=%v homes=%v", result, err, *homes)
			}
			if _, statErr := os.Stat((*homes)[0]); statErr != nil {
				t.Fatalf("abnormal resumed attempt removed run Home: %v", statErr)
			}
			after := snapshotTreeBytes(t, snapshot)
			if !reflect.DeepEqual(after, before) {
				t.Fatalf("abnormal attempt replaced last good snapshot: before=%v after=%v", before, after)
			}
		})
	}
}

func TestGrokRetryAfterProcessErrorRestoresOnlyTrustedSnapshot(t *testing.T) {
	nativeID := "retry-only-trusted-native-session"
	var firstHome string
	deps, homes := grokResilienceDeps(t, func(_ context.Context, request AttemptRequest) ChildResult {
		location, err := findExecutionNativeSession(request.Plan.ConfigDir, nativeID)
		if err != nil {
			t.Fatalf("attempt %d did not restore snapshot: %v", request.Attempt, err)
		}
		if state := readExecutionNativeState(t, location); state != "trusted-before-retry" {
			t.Fatalf("attempt %d restored %q, want trusted-before-retry", request.Attempt, state)
		}
		if request.Attempt == 1 {
			firstHome = request.Plan.ConfigDir
			writeExecutionNativeSession(t, request.Plan.ConfigDir, nativeID, request.Plan.WorkDir, "untrusted-process-error-state")
			return ChildResult{
				Status: "failed", ExitCode: 1, NativeSessionID: nativeID, ProcessError: true,
				Events:     retryableEvent(FailureClassTransientProvider, nil),
				GrokStream: driver.GrokStreamValidity{Checked: true, Trust: driver.GrokTrustCompleteNativeFailure},
			}
		}
		if request.ResumeID != nativeID || request.Mode != "resume" {
			t.Fatalf("retry did not use trusted native id: %+v", request)
		}
		writeExecutionNativeSession(t, request.Plan.ConfigDir, nativeID, request.Plan.WorkDir, "trusted-after-retry")
		return ChildResult{
			Status: "done", NativeSessionID: nativeID, Events: doneEvent("ok"),
			GrokStream: driver.GrokStreamValidity{Checked: true, Trust: driver.GrokTrustCompleteSuccess},
		}
	})
	seedHome := t.TempDir()
	workDir := tempDir(t)
	writeExecutionNativeSession(t, seedHome, nativeID, workDir, "trusted-before-retry")
	if err := grok.RefreshNativeSessionSnapshot(deps.DataDir, seedHome, nativeID); err != nil {
		t.Fatal(err)
	}
	result, err := Execute(Request{ProfileName: "gk", Prompt: "retry trusted only", WorkDir: workDir, ResumeID: nativeID}, deps, &bytes.Buffer{}, &bytes.Buffer{})
	if err != nil || result.Status != "done" || len(*homes) != 2 {
		t.Fatalf("retry result=%+v err=%v homes=%v", result, err, *homes)
	}
	if _, statErr := os.Stat(firstHome); statErr != nil {
		t.Fatalf("process-error attempt Home was removed: %v", statErr)
	}
	restored := t.TempDir()
	if err := grok.RestoreNativeSessionSnapshot(deps.DataDir, restored, nativeID); err != nil {
		t.Fatal(err)
	}
	location, err := findExecutionNativeSession(restored, nativeID)
	if err != nil || readExecutionNativeState(t, location) != "trusted-after-retry" {
		t.Fatalf("successful retry did not refresh trusted state: location=%q err=%v", location, err)
	}
}

func snapshotTreeBytes(t *testing.T, root string) map[string]string {
	t.Helper()
	files := map[string]string{}
	if err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		files[relative] = string(data)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return files
}

func TestGrokExplicitResumeMissingCorruptAndTraversalFailBeforeChildLaunch(t *testing.T) {
	cases := []struct {
		name    string
		id      string
		prepare func(*testing.T, Dependencies, string)
		want    string
	}{
		{name: "missing", id: "missing-native-session", want: "was not found"},
		{name: "corrupt", id: "corrupt-native-session", want: "is invalid", prepare: func(t *testing.T, deps Dependencies, id string) {
			source := t.TempDir()
			writeExecutionNativeSession(t, source, id, t.TempDir(), "valid")
			if err := grok.RefreshNativeSessionSnapshot(deps.DataDir, source, id); err != nil {
				t.Fatal(err)
			}
			path, _ := grok.NativeSessionSnapshotPath(deps.DataDir, id)
			updates := findExecutionNativeSessionFile(t, path, id, "updates.jsonl")
			if err := os.WriteFile(updates, []byte(`{"type":`), 0o600); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "path traversal", id: filepath.Join("..", "..", "escape"), want: "was not found"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			launched := false
			deps, _ := grokResilienceDeps(t, func(context.Context, AttemptRequest) ChildResult {
				launched = true
				return ChildResult{}
			})
			if tc.prepare != nil {
				tc.prepare(t, deps, tc.id)
			}
			result, err := Execute(Request{
				ProfileName: "gk", Prompt: "explicit native resume", WorkDir: tempDir(t), ResumeID: tc.id,
			}, deps, &bytes.Buffer{}, &bytes.Buffer{})
			if err == nil || !strings.Contains(err.Error(), tc.want) || result.Status != "failed" {
				t.Fatalf("result=%+v err=%v, want error containing %q", result, err, tc.want)
			}
			if launched {
				t.Fatal("invalid explicit Grok resume launched a child")
			}
		})
	}
}

func TestGrokNativeValidityControlsResultAndRunHomeLifecycle(t *testing.T) {
	cases := []struct {
		name      string
		child     ChildResult
		wantDone  bool
		wantExit  int
		wantError string
	}{
		{name: "empty", child: ChildResult{Status: "done", GrokStream: invalidGrokStream()}, wantExit: 1, wantError: invalidGrokNativeOutputError},
		{name: "malformed", child: ChildResult{Status: "done", GrokStream: invalidGrokStream()}, wantExit: 1, wantError: invalidGrokNativeOutputError},
		{name: "truncated", child: ChildResult{Status: "done", GrokStream: invalidGrokStream()}, wantExit: 1, wantError: invalidGrokNativeOutputError},
		{name: "incomplete", child: ChildResult{Status: "done", GrokStream: invalidGrokStream()}, wantExit: 1, wantError: invalidGrokNativeOutputError},
		{name: "duplicate", child: ChildResult{Status: "done", Events: append(doneEvent("first"), doneEvent("second")...), GrokStream: invalidGrokStream()}, wantExit: 1, wantError: invalidGrokNativeOutputError},
		{name: "non-final after terminal", child: ChildResult{Status: "done", Events: doneEvent("answer"), GrokStream: invalidGrokStream()}, wantExit: 1, wantError: invalidGrokNativeOutputError},
		{name: "failed", child: ChildResult{Status: "done", Events: retryableEvent(FailureClassNonRetryable, map[string]any{"error": "native detail"}), GrokStream: driver.GrokStreamValidity{Checked: true, Trust: driver.GrokTrustCompleteNativeFailure}}, wantExit: 1, wantError: "native detail"},
		{name: "cancelled", child: ChildResult{Status: "done", Events: []protocol.Event{{Type: protocol.EventRunFinished, Data: map[string]any{"status": "failed", "error": "Cancelled"}}}, GrokStream: driver.GrokStreamValidity{Checked: true, Trust: driver.GrokTrustCancelled}}, wantExit: 1, wantError: "Cancelled"},
		{name: "valid success", child: ChildResult{Status: "done", Events: doneEvent("answer"), GrokStream: driver.GrokStreamValidity{Checked: true, Trust: driver.GrokTrustCompleteSuccess}}, wantDone: true},
		{name: "native nonzero", child: ChildResult{Status: "failed", ExitCode: 7, Error: "specific native failure", ProcessError: true, Events: []protocol.Event{{Type: protocol.EventRunFinished, Data: map[string]any{"status": "failed", "error": "specific native failure"}}}, GrokStream: driver.GrokStreamValidity{Checked: true, Trust: driver.GrokTrustCompleteNativeFailure}}, wantExit: 7, wantError: "specific native failure"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			deps, homes := grokResilienceDeps(t, func(context.Context, AttemptRequest) ChildResult {
				return tc.child
			})
			result, err := Execute(Request{ProfileName: "gk", Prompt: "validate native stream", WorkDir: tempDir(t)}, deps, &bytes.Buffer{}, &bytes.Buffer{})
			if len(*homes) != 1 {
				t.Fatalf("attempt homes = %v, want one", *homes)
			}
			if tc.wantDone {
				if err != nil || result.Status != "done" || result.ExitCode != 0 || result.Error != "" {
					t.Fatalf("valid result = %+v err=%v", result, err)
				}
				if _, statErr := os.Stat((*homes)[0]); !os.IsNotExist(statErr) {
					t.Fatalf("valid success retained run Home: %v", statErr)
				}
				return
			}
			if err == nil || result.Status != "failed" || result.ExitCode != tc.wantExit || result.Error != tc.wantError {
				t.Fatalf("failed result = %+v err=%v, want exit=%d error=%q", result, err, tc.wantExit, tc.wantError)
			}
			if _, statErr := os.Stat((*homes)[0]); statErr != nil {
				t.Fatalf("failed stream removed run Home: %v", statErr)
			}
		})
	}
}

func TestGrokChildErrorOverridesValidNativeSuccessAndRetainsRunHome(t *testing.T) {
	deps, homes := grokResilienceDeps(t, func(context.Context, AttemptRequest) ChildResult {
		return ChildResult{
			Status: "done", ExitCode: 0,
			Error:      "close Grok execution transcript: device failure",
			Events:     doneEvent("otherwise valid"),
			GrokStream: driver.GrokStreamValidity{Checked: true, Trust: driver.GrokTrustCompleteSuccess},
		}
	})
	result, err := Execute(Request{
		ProfileName: "gk", Prompt: "preserve child error", WorkDir: tempDir(t),
	}, deps, &bytes.Buffer{}, &bytes.Buffer{})
	if err == nil || result.Status != "failed" || result.ExitCode != 1 || result.Error != "close Grok execution transcript: device failure" {
		t.Fatalf("done/zero/valid-stream plus child error = result %+v err=%v", result, err)
	}
	if len(*homes) != 1 {
		t.Fatalf("attempt homes = %v, want one", *homes)
	}
	if _, statErr := os.Stat((*homes)[0]); statErr != nil {
		t.Fatalf("child-error path removed RemoveOnSuccess Home: %v", statErr)
	}
}

func TestNonGrokChildErrorIsGenericFailedAttemptInvariant(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 7, 12, 6, 30, 0, 0, time.UTC)}
	deps := codexResilienceDeps(t, clock, func(context.Context, AttemptRequest) ChildResult {
		return ChildResult{
			Status: "done", ExitCode: 0,
			Error:  "close child execution transcript: device failure",
			Events: doneEvent("otherwise valid"),
		}
	})
	result, err := Execute(Request{
		ProfileName: "codex-child-error", Prompt: "generic invariant", WorkDir: tempDir(t),
	}, deps, &bytes.Buffer{}, &bytes.Buffer{})
	if err == nil || result.Status != "failed" || result.ExitCode != 1 || result.Error != "close child execution transcript: device failure" {
		t.Fatalf("non-Grok done/zero plus child error = result %+v err=%v", result, err)
	}
}

func TestExecuteMissingResumeUsesFreshSameProfile(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 7, 12, 6, 30, 0, 0, time.UTC)}
	var calls []AttemptRequest
	deps := codexResilienceDeps(t, clock, func(_ context.Context, request AttemptRequest) ChildResult {
		calls = append(calls, request)
		if request.Attempt == 1 {
			return ChildResult{Status: "failed", ExitCode: 1, Events: retryableEvent(FailureClassTransientProvider, nil)}
		}
		return ChildResult{Status: "done", Events: doneEvent("fresh")}
	})
	result, err := Execute(Request{ProfileName: "exact", Prompt: "keep", WorkDir: tempDir(t)}, deps, &bytes.Buffer{}, &bytes.Buffer{})
	if err != nil || result.Status != "done" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	if len(calls) != 2 || calls[1].Mode != "fresh" || calls[1].ResumeID != "" {
		t.Fatalf("calls=%+v want fresh empty-resume retry", calls)
	}
}

func TestExecuteRecoveryTimestampFallsBackWithoutSleep(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 7, 12, 6, 30, 0, 0, time.UTC)}
	sleeper := &recordingSleeper{clock: clock}
	var profiles []string
	deps := codexResilienceDeps(t, clock, func(_ context.Context, request AttemptRequest) ChildResult {
		profiles = append(profiles, request.Profile)
		if request.Profile == "first" {
			return ChildResult{Status: "failed", ExitCode: 1, Events: retryableEvent(FailureClassProfileSpecificLimit, map[string]any{"recovery_at": "2026-07-12T07:00:00Z"})}
		}
		return ChildResult{Status: "done", Events: doneEvent("second")}
	})
	deps.Sleeper = sleeper
	result, err := Execute(Request{Selector: "policy", PolicyName: "fast", PolicyCandidates: []string{"first", "second"}, Prompt: "same", WorkDir: tempDir(t)}, deps, &bytes.Buffer{}, &bytes.Buffer{})
	if err != nil || result.Status != "done" || result.Profile != "second" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	if !reflect.DeepEqual(profiles, []string{"first", "second"}) {
		t.Fatalf("profiles=%v", profiles)
	}
	if len(sleeper.delays) != 0 {
		t.Fatalf("timestamp recovery slept: %v", sleeper.delays)
	}
	check := NewCircuitStore(deps.StateRoot, clock).Check("first")
	if !check.Open || check.Record.UnlockAt != "2026-07-12T07:00:00Z" || check.Record.RetryCount != 0 {
		t.Fatalf("first circuit=%+v", check)
	}
}

func TestExecutePolicyExhaustionIsPerProfileAndTerminalOnce(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 7, 12, 6, 30, 0, 0, time.UTC)}
	sleeper := &recordingSleeper{clock: clock}
	var calls []AttemptRequest
	deps := codexResilienceDeps(t, clock, func(_ context.Context, request AttemptRequest) ChildResult {
		calls = append(calls, request)
		if request.Profile == "first" {
			return ChildResult{Status: "failed", ExitCode: 1, Events: retryableEvent(FailureClassTransientProvider, nil)}
		}
		return ChildResult{Status: "done", Events: doneEvent("sibling")}
	})
	deps.Sleeper = sleeper
	result, err := Execute(Request{Selector: "policy", PolicyName: "fast", PolicyCandidates: []string{"first", "sibling"}, Prompt: "unchanged", WorkDir: tempDir(t)}, deps, &bytes.Buffer{}, &bytes.Buffer{})
	if err != nil || result.Status != "done" || result.Profile != "sibling" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	if len(calls) != maxProfileRetries+2 {
		t.Fatalf("child calls=%d want %d first + 1 sibling", len(calls), maxProfileRetries+1)
	}
	for i := 0; i < maxProfileRetries+1; i++ {
		if calls[i].Profile != "first" {
			t.Fatalf("retry call %d switched profile: %+v", i+1, calls[i])
		}
	}
	check := NewCircuitStore(deps.StateRoot, clock).Check("first")
	if !check.Open || check.Record.ReasonCode != CircuitReasonRetryExhausted || check.Record.RetryCount != maxProfileRetries {
		t.Fatalf("first exhaustion circuit=%+v", check)
	}
}

func TestExecuteStreamHasOneTerminalRunFinished(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 7, 12, 6, 30, 0, 0, time.UTC)}
	deps := codexResilienceDeps(t, clock, func(_ context.Context, request AttemptRequest) ChildResult {
		if request.Attempt == 1 {
			return ChildResult{Status: "failed", ExitCode: 1, Events: retryableEvent(FailureClassTransientProvider, nil)}
		}
		return ChildResult{Status: "done", Events: doneEvent("done")}
	})
	var out bytes.Buffer
	result, err := Execute(Request{ProfileName: "exact", Prompt: "p", WorkDir: tempDir(t), Format: protocol.OutputFormatStreamJSON}, deps, &out, &bytes.Buffer{})
	if err != nil || result.Status != "done" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	var envelopes []protocol.Envelope
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		var env protocol.Envelope
		if err := json.Unmarshal([]byte(line), &env); err != nil {
			t.Fatal(err)
		}
		envelopes = append(envelopes, env)
	}
	if len(envelopes) == 0 || envelopes[0].Type != protocol.EventRunStarted {
		t.Fatalf("events=%v", envelopes)
	}
	runFinished := 0
	for i, env := range envelopes {
		if env.Seq != i+1 {
			t.Fatalf("seq=%d at index %d", env.Seq, i)
		}
		if env.Type == protocol.EventRunFinished {
			runFinished++
			if env.Data["terminal"] != true {
				t.Fatalf("run_finished data=%v missing terminal=true", env.Data)
			}
		}
	}
	if runFinished != 1 {
		t.Fatalf("run_finished count=%d events=%s", runFinished, out.String())
	}
}

func TestExecutePolicyRunStartedEmitsResolvedProfile(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 7, 12, 6, 30, 0, 0, time.UTC)}
	deps := codexResilienceDeps(t, clock, func(_ context.Context, request AttemptRequest) ChildResult {
		if request.Profile != "codex-spark" {
			t.Fatalf("expected first candidate codex-spark to run, got %q", request.Profile)
		}
		return ChildResult{Status: "done", Events: doneEvent("done")}
	})
	var out bytes.Buffer
	result, err := Execute(Request{
		Selector:         "policy",
		PolicyName:       "fast",
		PolicyCandidates: []string{"codex-spark", "codex-dsf"},
		Prompt:           "p",
		WorkDir:          tempDir(t),
		Format:           protocol.OutputFormatStreamJSON,
	}, deps, &out, &bytes.Buffer{})
	if err != nil || result.Status != "done" || result.Profile != "codex-spark" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	var lines []string
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		if line == "" {
			continue
		}
		var env protocol.Envelope
		if err := json.Unmarshal([]byte(line), &env); err != nil {
			t.Fatal(err)
		}
		if env.Type == protocol.EventRunStarted {
			if env.Data["selector"] != "policy" {
				t.Fatalf("run_started selector=%v want policy", env.Data["selector"])
			}
			if env.Data["policy"] != "fast" {
				t.Fatalf("run_started policy=%v want fast", env.Data["policy"])
			}
			if env.Data["profile"] != "codex-spark" {
				t.Fatalf("run_started profile=%v want codex-spark (resolved candidate)", env.Data["profile"])
			}
		}
		lines = append(lines, line)
	}
	if len(lines) == 0 {
		t.Fatal("no stream envelopes emitted")
	}
}

func TestExecuteExplicitProfileRunStartedProfileUnchanged(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 7, 12, 6, 30, 0, 0, time.UTC)}
	deps := codexResilienceDeps(t, clock, func(_ context.Context, request AttemptRequest) ChildResult {
		return ChildResult{Status: "done", Events: doneEvent("done")}
	})
	var out bytes.Buffer
	result, err := Execute(Request{ProfileName: "exact", Prompt: "p", WorkDir: tempDir(t), Format: protocol.OutputFormatStreamJSON}, deps, &out, &bytes.Buffer{})
	if err != nil || result.Status != "done" || result.Profile != "exact" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	first := strings.SplitN(strings.TrimSpace(out.String()), "\n", 2)[0]
	var env protocol.Envelope
	if err := json.Unmarshal([]byte(first), &env); err != nil {
		t.Fatal(err)
	}
	if env.Type != protocol.EventRunStarted {
		t.Fatalf("first envelope type=%q want run_started", env.Type)
	}
	if env.Data["selector"] != "profile" {
		t.Fatalf("run_started selector=%v want profile", env.Data["selector"])
	}
	if env.Data["profile"] != "exact" {
		t.Fatalf("run_started profile=%v want exact", env.Data["profile"])
	}
	if env.Data["client_family"] != "codex" {
		t.Fatalf("run_started client_family=%v want codex", env.Data["client_family"])
	}
	cwd, _ := env.Data["cwd"].(string)
	if cwd == "" {
		t.Fatalf("run_started must carry a non-empty cwd: %v", env.Data)
	}
	if _, ok := env.Data["policy"]; ok {
		t.Fatalf("run_started must not carry policy metadata for explicit profile: %v", env.Data)
	}
}

func TestExecuteRunStartedAndAttemptStartedCarryClientFamilyAndCwd(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 7, 12, 6, 30, 0, 0, time.UTC)}
	work := tempDir(t)
	deps := codexResilienceDeps(t, clock, func(_ context.Context, _ AttemptRequest) ChildResult {
		return ChildResult{Status: "done", Events: doneEvent("done")}
	})
	var out bytes.Buffer
	result, err := Execute(Request{ProfileName: "exact", Prompt: "p", WorkDir: work, Format: protocol.OutputFormatStreamJSON}, deps, &out, &bytes.Buffer{})
	if err != nil || result.Status != "done" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	var started, attemptStarted protocol.Envelope
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		if line == "" {
			continue
		}
		var env protocol.Envelope
		if err := json.Unmarshal([]byte(line), &env); err != nil {
			t.Fatal(err)
		}
		if env.Type == protocol.EventRunStarted && started.Type == "" {
			started = env
		}
		if env.Type == protocol.EventAttemptStarted && attemptStarted.Type == "" {
			attemptStarted = env
		}
	}
	if started.Type == "" {
		t.Fatal("no run_started envelope emitted")
	}
	if started.Data["profile"] != "exact" {
		t.Fatalf("run_started profile=%v want exact", started.Data["profile"])
	}
	if started.Data["client_family"] != "codex" {
		t.Fatalf("run_started client_family=%v want codex", started.Data["client_family"])
	}
	if cwd, _ := started.Data["cwd"].(string); cwd == "" {
		t.Fatalf("run_started must carry non-empty cwd: %v", started.Data)
	}
	if attemptStarted.Type == "" {
		t.Fatal("no attempt_started envelope emitted")
	}
	if attemptStarted.Data["client_family"] != "codex" {
		t.Fatalf("attempt_started client_family=%v want codex", attemptStarted.Data["client_family"])
	}
	if attemptStarted.Data["profile"] != "exact" {
		t.Fatalf("attempt_started profile=%v want exact", attemptStarted.Data["profile"])
	}
}

func TestExecuteExactProfileNeverFallsBackOrRetriesNonRetryable(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 7, 12, 6, 30, 0, 0, time.UTC)}
	calls := 0
	deps := codexResilienceDeps(t, clock, func(_ context.Context, request AttemptRequest) ChildResult {
		calls++
		if request.Profile != "exact" {
			t.Fatalf("unexpected switched profile %q", request.Profile)
		}
		return ChildResult{Status: "failed", ExitCode: 1, Error: "invalid request", Events: retryableEvent(FailureClassNonRetryable, nil)}
	})
	result, err := Execute(Request{Selector: "profile", ProfileName: "exact", Prompt: "p", WorkDir: tempDir(t)}, deps, &bytes.Buffer{}, &bytes.Buffer{})
	if err == nil || result.FailureClass != string(FailureClassNonRetryable) || calls != 1 {
		t.Fatalf("result=%+v err=%v calls=%d", result, err, calls)
	}
	if check := NewCircuitStore(deps.StateRoot, clock).Check("exact"); check.Open || check.Record != nil {
		t.Fatalf("non-retryable wrote circuit: %+v", check)
	}
}

func TestExecuteExactOpenCircuitSkipsChild(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 7, 12, 6, 30, 0, 0, time.UTC)}
	deps := codexResilienceDeps(t, clock, func(_ context.Context, _ AttemptRequest) ChildResult {
		t.Fatal("open exact circuit started a child")
		return ChildResult{}
	})
	opened := clock.Now()
	store := NewCircuitStore(deps.StateRoot, clock)
	if !store.Write("exact", makeCircuitRecord("exact", ClassificationTransientProvider, CircuitReasonStructuredRecovery, 0, opened, opened.Add(time.Hour))) {
		t.Fatal("write open circuit")
	}
	result, err := Execute(Request{ProfileName: "exact", Prompt: "p", WorkDir: tempDir(t)}, deps, &bytes.Buffer{}, &bytes.Buffer{})
	if err == nil || result.FailureClass != string(FailureClassTransientProvider) || result.Attempts[0].Attempts != 0 {
		t.Fatalf("result=%+v err=%v", result, err)
	}
}

func TestExecutePolicyOpenCircuitFallbackFromProfile(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 7, 12, 6, 30, 0, 0, time.UTC)}
	deps := codexResilienceDeps(t, clock, func(_ context.Context, req AttemptRequest) ChildResult {
		if req.Profile == "first" {
			t.Fatal("open circuit for 'first' started a child")
		}
		return ChildResult{Status: "done", Events: doneEvent("second profile")}
	})
	store := NewCircuitStore(deps.StateRoot, clock)
	opened := clock.Now()
	store.Write("first", makeCircuitRecord("first", ClassificationTransientProvider, CircuitReasonStructuredRecovery, 0, opened, opened.Add(time.Hour)))

	var out bytes.Buffer
	result, err := Execute(Request{
		Selector:         "policy",
		PolicyName:       "fast",
		PolicyCandidates: []string{"first", "second"},
		Prompt:           "p",
		WorkDir:          tempDir(t),
		Format:           protocol.OutputFormatStreamJSON,
	}, deps, &out, &bytes.Buffer{})
	if err != nil || result.Status != "done" || result.Profile != "second" {
		t.Fatalf("result=%+v err=%v", result, err)
	}

	var fallbackEvents []protocol.Envelope
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		var env protocol.Envelope
		if err := json.Unmarshal([]byte(line), &env); err != nil {
			t.Fatal(err)
		}
		if env.Type == protocol.EventPolicyFallback {
			fallbackEvents = append(fallbackEvents, env)
		}
	}
	if len(fallbackEvents) == 0 {
		t.Fatal("expected at least one policy_fallback event")
	}
	from, _ := fallbackEvents[0].Data["from_profile"].(string)
	if from != "first" {
		t.Fatalf("from_profile=%q want %q (the circuit-open candidate)", from, "first")
	}
	if to, _ := fallbackEvents[0].Data["to_profile"].(string); to != "second" {
		t.Fatalf("to_profile=%q want %q", to, "second")
	}
}

func TestExecuteCodeBuddyResetOpensCircuitAndPolicyFallbackWithZeroRetry(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 7, 12, 6, 30, 0, 0, time.UTC)}
	sleeper := &recordingSleeper{clock: clock}
	var profiles []string
	deps := codexResilienceDeps(t, clock, func(_ context.Context, request AttemptRequest) ChildResult {
		profiles = append(profiles, request.Profile)
		if request.Profile == "cb-hy" {
			return ChildResult{Status: "done", ExitCode: 0, Events: []protocol.Event{{Type: "message", Data: map[string]any{
				"role": "assistant",
				"text": "429 您的使用量已超出频率限制，将在 2026-07-12 15:00:00 UTC+8 重置，您也可以切换其他模型继续使用。 (eae0465ed7664c40bcb0bb7f08afb8ca/1d37242c-c2ea-4c31-812a-2b2cd1e13a92)",
			}}}}
		}
		return ChildResult{Status: "done", ExitCode: 0, Events: doneEvent("cb-dsf succeeded")}
	})
	deps.Sleeper = sleeper

	var out bytes.Buffer
	result, err := Execute(Request{
		Selector:         "policy",
		PolicyName:       "fast",
		PolicyCandidates: []string{"cb-hy", "cb-dsf"},
		Prompt:           "test",
		WorkDir:          tempDir(t),
		Format:           protocol.OutputFormatStreamJSON,
	}, deps, &out, &bytes.Buffer{})
	if err != nil || result.Status != "done" || result.Profile != "cb-dsf" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	if !reflect.DeepEqual(profiles, []string{"cb-hy", "cb-dsf"}) {
		t.Fatalf("profiles=%v want [cb-hy cb-dsf]", profiles)
	}
	if len(sleeper.delays) != 0 {
		t.Fatalf("sleep delays=%v want zero (no sleep after profile_specific_limit)", sleeper.delays)
	}
	check := NewCircuitStore(deps.StateRoot, clock).Check("cb-hy")
	if !check.Open || check.Record.Classification != FailureClassProfileSpecificLimit || check.Record.UnlockAt != "2026-07-12T07:00:00Z" {
		t.Fatalf("cb-hy circuit=%+v want open profile_specific_limit circuit", check)
	}
	if check.Record.RetryCount != 0 {
		t.Fatalf("cb-hy retry_count=%d want 0 (immediate circuit)", check.Record.RetryCount)
	}

	var retryScheduled, circuitOpened, policyFallback int
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		var env protocol.Envelope
		if err := json.Unmarshal([]byte(line), &env); err != nil {
			t.Fatal(err)
		}
		switch env.Type {
		case protocol.EventRetryScheduled:
			retryScheduled++
		case protocol.EventCircuitOpened:
			circuitOpened++
		case protocol.EventPolicyFallback:
			policyFallback++
		}
	}
	if retryScheduled != 0 {
		t.Fatalf("retry_scheduled count=%d want 0 (immediate circuit, no retry)", retryScheduled)
	}
	if circuitOpened != 1 {
		t.Fatalf("circuit_opened count=%d want 1", circuitOpened)
	}
	if policyFallback != 1 {
		t.Fatalf("policy_fallback count=%d want 1", policyFallback)
	}
}

// TestExecuteKimiBillingCycleDenialOpensCircuitAndPolicyFallbackWithZeroRetry
// reproduces the hard-denial defect: Kimi's exact billing-cycle 403 message is
// a permission/quota denial where retrying is pointless, but the generic
// profile_specific_limit text heuristic buckets it like a recoverable limit.
// The exact profile must be circuited immediately after exactly one child
// attempt (retry_count=0, no retry_scheduled), so policy fallback proceeds
// without seven pointless same-profile retries.
func TestExecuteKimiBillingCycleDenialOpensCircuitAndPolicyFallbackWithZeroRetry(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 7, 12, 6, 30, 0, 0, time.UTC)}
	sleeper := &recordingSleeper{clock: clock}
	var profiles []string
	deps := codexResilienceDeps(t, clock, func(_ context.Context, request AttemptRequest) ChildResult {
		profiles = append(profiles, request.Profile)
		if request.Profile == "cc-kimi" {
			return ChildResult{Status: "failed", ExitCode: 1, Events: []protocol.Event{{Type: protocol.EventRunFinished, Data: map[string]any{
				"status": "failed",
				"error":  "Error code: 403 - insufficient_quota: You've reached your usage limit for this billing cycle. Please try again later or upgrade your plan.",
			}}}}
		}
		return ChildResult{Status: "done", ExitCode: 0, Events: doneEvent("cc-glm succeeded")}
	})
	deps.Sleeper = sleeper

	var out bytes.Buffer
	result, err := Execute(Request{
		Selector:         "policy",
		PolicyName:       "fast",
		PolicyCandidates: []string{"cc-kimi", "cc-glm"},
		Prompt:           "test",
		WorkDir:          tempDir(t),
		Format:           protocol.OutputFormatStreamJSON,
	}, deps, &out, &bytes.Buffer{})
	if err != nil || result.Status != "done" || result.Profile != "cc-glm" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	if !reflect.DeepEqual(profiles, []string{"cc-kimi", "cc-glm"}) {
		t.Fatalf("profiles=%v want exactly one hard-denied cc-kimi attempt then policy fallback [cc-kimi cc-glm]", profiles)
	}
	if len(sleeper.delays) != 0 {
		t.Fatalf("sleep delays=%v want zero (hard billing-cycle denial sleeps before retry)", sleeper.delays)
	}
	check := NewCircuitStore(deps.StateRoot, clock).Check("cc-kimi")
	if !check.Open {
		t.Fatalf("cc-kimi circuit=%+v want open after first hard denial", check)
	}
	if check.Record.RetryCount != 0 {
		t.Fatalf("cc-kimi retry_count=%d want 0 (immediate per-profile circuit)", check.Record.RetryCount)
	}
	if check.Record.ReasonCode != CircuitReasonHardProfileLimit {
		t.Fatalf("cc-kimi reason=%q want %q (immediate hard-limit circuit, not retry exhaustion)", check.Record.ReasonCode, CircuitReasonHardProfileLimit)
	}

	var retryScheduled, circuitOpened, policyFallback int
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		var env protocol.Envelope
		if err := json.Unmarshal([]byte(line), &env); err != nil {
			t.Fatal(err)
		}
		switch env.Type {
		case protocol.EventRetryScheduled:
			retryScheduled++
		case protocol.EventCircuitOpened:
			circuitOpened++
		case protocol.EventPolicyFallback:
			policyFallback++
		}
	}
	if retryScheduled != 0 {
		t.Fatalf("retry_scheduled count=%d want 0 (hard denial schedules no retry)", retryScheduled)
	}
	if circuitOpened != 1 {
		t.Fatalf("circuit_opened count=%d want 1", circuitOpened)
	}
	if policyFallback != 1 {
		t.Fatalf("policy_fallback count=%d want 1", policyFallback)
	}
}

// TestMalformedNormalizedEventFailsClosedWithoutLeak verifies R4: when a codec
// hands the sink an unknown/malformed normalized event, the child attempt fails
// through a privacy-safe run_finished error and no native payload reaches the
// public stream or result.
func TestMalformedNormalizedEventFailsClosedWithoutLeak(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 7, 12, 6, 30, 0, 0, time.UTC)}
	const secret = "PRIVATE_NATIVE_PAYLOAD_MUST_NOT_ESCAPE"
	deps := codexResilienceDeps(t, clock, func(_ context.Context, _ AttemptRequest) ChildResult {
		return ChildResult{
			Status: "done", ExitCode: 0,
			Events: []protocol.Event{
				{Type: "message", Data: map[string]any{"text": "ok"}},
				{Type: "native_secret", Data: map[string]any{"secret": secret}},
			},
		}
	})

	var out bytes.Buffer
	result, err := Execute(Request{
		ProfileName: "exact", Prompt: "p", WorkDir: tempDir(t), Format: protocol.OutputFormatStreamJSON,
	}, deps, &out, &bytes.Buffer{})
	if err == nil || result.Status != "failed" {
		t.Fatalf("malformed event must fail the attempt: result=%+v err=%v", result, err)
	}
	if result.Error != normalizedEventValidationError {
		t.Fatalf("result error=%q want privacy-safe %q", result.Error, normalizedEventValidationError)
	}
	if strings.Contains(out.String(), secret) {
		t.Fatalf("native payload leaked into the public stream: %s", out.String())
	}
	if strings.Contains(result.Summary, secret) {
		t.Fatalf("native payload leaked into the result summary: %q", result.Summary)
	}
}

// TestUnknownNormalizedEventAfterDoneStillFailsClosed verifies that a malformed
// event poisons the attempt even when it follows an otherwise valid done
// terminal, so a prior success can never mask the failure.
func TestUnknownNormalizedEventAfterDoneStillFailsClosed(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 7, 12, 6, 30, 0, 0, time.UTC)}
	deps := codexResilienceDeps(t, clock, func(_ context.Context, _ AttemptRequest) ChildResult {
		return ChildResult{
			Status: "done", ExitCode: 0,
			Events: []protocol.Event{
				{Type: protocol.EventRunFinished, Data: map[string]any{"status": "done"}},
				{Type: "bogus_type", Data: map[string]any{"leak": "x"}},
			},
		}
	})
	result, err := Execute(Request{ProfileName: "exact", Prompt: "p", WorkDir: tempDir(t)}, deps, &bytes.Buffer{}, &bytes.Buffer{})
	if err == nil || result.Status != "failed" || result.Error != normalizedEventValidationError {
		t.Fatalf("postrun malformed event must fail closed: result=%+v err=%v", result, err)
	}
}

// TestRunStartedAndAttemptStartedAddConcreteClient covers R6: run_started and
// attempt_started carry an additive concrete client identifier alongside the
// compatibility client_family. CodeBuddy keeps client_family=claude while the
// additive client identifies the codebuddy adapter.
func TestRunStartedAndAttemptStartedAddConcreteClient(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 7, 12, 6, 30, 0, 0, time.UTC)}
	for _, tc := range []struct {
		name          string
		client        string
		wantFamily    string
		wantConcrete  string
		credentialEnv string
	}{
		{name: "codebuddy", client: "codebuddy", wantFamily: "claude", wantConcrete: "codebuddy", credentialEnv: "CB_TOKEN"},
		{name: "codex", client: "codex", wantFamily: "codex", wantConcrete: "codex", credentialEnv: "CODEX_AUTH_TOKEN"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			deps := clientResilienceDeps(t, clock, func(_ context.Context, _ AttemptRequest) ChildResult {
				return ChildResult{Status: "done", Events: doneEvent("done")}
			}, tc.client, tc.credentialEnv)
			var out bytes.Buffer
			result, err := Execute(Request{
				ProfileName: "exact", Prompt: "p", WorkDir: tempDir(t), Format: protocol.OutputFormatStreamJSON,
			}, deps, &out, &bytes.Buffer{})
			if err != nil || result.Status != "done" {
				t.Fatalf("result=%+v err=%v", result, err)
			}
			var started, attemptStarted protocol.Envelope
			for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
				if line == "" {
					continue
				}
				var env protocol.Envelope
				if err := json.Unmarshal([]byte(line), &env); err != nil {
					t.Fatal(err)
				}
				if env.Type == protocol.EventRunStarted && started.Type == "" {
					started = env
				}
				if env.Type == protocol.EventAttemptStarted && attemptStarted.Type == "" {
					attemptStarted = env
				}
			}
			if started.Data["client_family"] != tc.wantFamily {
				t.Fatalf("run_started client_family=%v want %q", started.Data["client_family"], tc.wantFamily)
			}
			if started.Data["client"] != tc.wantConcrete {
				t.Fatalf("run_started client=%v want %q", started.Data["client"], tc.wantConcrete)
			}
			if attemptStarted.Data["client_family"] != tc.wantFamily {
				t.Fatalf("attempt_started client_family=%v want %q", attemptStarted.Data["client_family"], tc.wantFamily)
			}
			if attemptStarted.Data["client"] != tc.wantConcrete {
				t.Fatalf("attempt_started client=%v want %q", attemptStarted.Data["client"], tc.wantConcrete)
			}
		})
	}
}
