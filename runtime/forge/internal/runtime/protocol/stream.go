package protocol

import "time"

const (
	StreamProtocol = "forge.agent.stream"
	StreamVersion  = 1
)

// Envelope is the Forge Agent Stream v1 wire envelope. The field order keeps
// the existing encoder's deterministic JSON key order unchanged.
type Envelope struct {
	Data      map[string]any `json:"data"`
	Protocol  string         `json:"protocol"`
	RunID     string         `json:"run_id"`
	Seq       int            `json:"seq"`
	Timestamp time.Time      `json:"timestamp"`
	Type      string         `json:"type"`
	Version   int            `json:"version"`
}
