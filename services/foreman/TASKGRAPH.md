# TaskGraph & FWA Operator Notes

## TaskGraph Lifecycle Control

- **paused**: stops scheduling new nodes. Already in-flight nodes continue running.
- **active.running**: lists nodes currently in-flight. A paused graph may show running nodes until they reach natural terminal state.
- **cancel_graph**: the hard-stop signal. Cancels all in-flight task runs and transitions the graph to cancelled.

These are runtime signals only; no TaskGraph runner behavior is changed by this document.

## Native FWA LLM Configuration

The `fwa.llm.http_timeout_ms` field is optional. When omitted, it defaults to **120000** (2 minutes). An explicit positive integer value overrides the default.

Example:

```json
{
  "fwa": {
    "backend": "native",
    "workspace_root": "/path/to/workspace",
    "llm": {
      "model": "provider/model",
      "http_timeout_ms": 120000
    }
  }
}
```

A smaller value such as 30000 (30 seconds) may be used for faster-failing requests.
