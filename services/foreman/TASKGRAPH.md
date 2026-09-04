# TaskGraph Operator Notes

## TaskGraph Lifecycle Control

- **paused**: stops scheduling new nodes. Already in-flight nodes continue running.
- **active.running**: lists nodes currently in-flight. A paused graph may show running nodes until they reach natural terminal state.
- **cancel_graph**: the hard-stop signal. Cancels all in-flight task runs and transitions the graph to cancelled.

These are runtime signals only; no TaskGraph runner behavior is changed by this document.
