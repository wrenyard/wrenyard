package protocol

// Usage is the normalized usage payload emitted by the native client adapter.
// Its keys remain intentionally open because native families currently expose
// different usage details.
type Usage map[string]any

// Result is the normalized result of one Forge execution.
type Result struct {
	Status          string            `json:"status"`
	Profile         string            `json:"profile"`
	ClientFamily    string            `json:"client_family"`
	NativeSessionID string            `json:"native_session_id,omitempty"`
	Summary         string            `json:"summary,omitempty"`
	ExitCode        int               `json:"exit_code"`
	Usage           Usage             `json:"usage,omitempty"`
	Error           string            `json:"error,omitempty"`
	FailureClass    string            `json:"failure_class,omitempty"`
	CircuitProfiles []string          `json:"circuit_profiles,omitempty"`
	CircuitUnlockAt map[string]string `json:"circuit_unlock_at,omitempty"`
	Attempts        []AttemptSummary  `json:"attempts,omitempty"`
}

// AttemptSummary is the privacy-safe per-profile execution accounting
// included in final results. It contains no prompt, command, credential, or
// downstream error text.
type AttemptSummary struct {
	Profile        string `json:"profile"`
	Attempts       int    `json:"attempts"`
	Retries        int    `json:"retries"`
	ResumeAttempts int    `json:"resume_attempts"`
	FreshAttempts  int    `json:"fresh_attempts"`
}

// OutputFormat selects the presentation contract for an execution result.
type OutputFormat string

const (
	OutputFormatText       OutputFormat = "text"
	OutputFormatJSON       OutputFormat = "json"
	OutputFormatStreamJSON OutputFormat = "stream-json"
)
