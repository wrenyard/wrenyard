package execution

import "github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/protocol"

// Result is the only execution result shape. It aliases the protocol result so
// the boundary never duplicates its fields and stays in sync with the wire
// contract owned by the protocol package.
type Result = protocol.Result
