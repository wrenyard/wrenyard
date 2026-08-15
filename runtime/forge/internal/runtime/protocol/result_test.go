package protocol

import (
	"encoding/json"
	"testing"
)

func TestResultResilienceFieldsRoundTripAndOldShape(t *testing.T) {
	old, err := json.Marshal(Result{Status: "done", Profile: "p", ExitCode: 0})
	if err != nil {
		t.Fatal(err)
	}
	if string(old) != `{"status":"done","profile":"p","client_family":"","exit_code":0}` {
		t.Fatalf("old result shape changed unexpectedly: %s", old)
	}

	want := Result{
		Status: "failed", Profile: "p", ExitCode: 1, FailureClass: "policy_exhausted",
		CircuitProfiles: []string{"p"}, CircuitUnlockAt: map[string]string{"p": "2026-07-12T07:00:00Z"},
		Attempts: []AttemptSummary{{Profile: "p", Attempts: 8, Retries: 7, ResumeAttempts: 7}},
	}
	raw, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	var got Result
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if got.FailureClass != want.FailureClass || len(got.Attempts) != 1 || got.Attempts[0].Retries != 7 {
		t.Fatalf("round trip=%+v want %+v", got, want)
	}
}
