package account

import (
	"encoding/json"
	"time"
)

type Observation struct {
	Source    string          `json:"source"`
	FetchedAt time.Time       `json:"fetched_at"`
	Data      json.RawMessage `json:"data"`
}
type Error struct {
	Code    string
	Message string
	Cause   error
}

func (e *Error) Error() string                         { return e.Message }
func (e *Error) Unwrap() error                         { return e.Cause }
func NewError(code, message string, cause error) error { return &Error{code, message, cause} }
