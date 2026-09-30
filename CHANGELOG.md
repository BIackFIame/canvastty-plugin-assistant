# Changelog

## Unreleased

Requires the CanvasTTY core with plugin API v2 and the `profile`/`canAsk` decide fields: the upcoming release after 1.7.0.

### What you'll notice

- The daily USD cap holds under load: parallel cloud calls can no longer pass it together.
- A model server that failed and came back is judged by the one probe call, not by late answers to calls from before it failed.
- The service's memory no longer grows for as long as CanvasTTY runs: statistics are bounded by the log's retention, and state for sessions whose close never arrived is dropped past 512 sessions.
- Parallel reviews no longer send your local model several requests at once; the second reviewer waits in the same queue of 4.
- Agents other than Claude Code cannot put a question in front of you from the hook; when a review would ask, they now get a deny with the Assistant's reason and what to do instead.
- The "YOLO only isolated" option is gone: YOLO and isolation are CanvasTTY's own rules now. A saved value is ignored.
- The settings page no longer loses a change made while another one is saving, and keeps a pasted key in its field when storing it fails.

### Budgets, breaker and reviews

- A cloud call holds an upper estimate of its cost (price table, request size, batches, retries) against the day's USD cap while it runs; the real cost replaces it, and an unknown cost counts as the estimate.
- A call whose signal is already aborted is never queued for the local backend, and the abort listener is removed once the call is admitted.
- The circuit breaker tags admissions with a generation: a late success or failure of a call admitted before it last opened changes nothing; only the half-open probe closes it.
- Referenced files that are unreadable, cut or past the file limit mark the set incomplete, and command review leaves the command to you.
- An Auto decision rechecks cancellation and the settings epoch after reading the log for its statistics.
- Field names that reach an object prototype are refused by the privacy gate.
- The review answers agents that cannot ask with a deny and its reason; a review that could not finish in a card whose profile still asks you (normal, plan) answers nothing, so the CLI's own prompt decides.

### Memory

- Statistics in memory follow `logRetentionDays`: older decisions and labels are swept hourly, and at once past 100 000 decisions. The first read of the log uses the same window instead of a fixed 400 days.
- The smart verifier takes the local backend slot (one request at a time, a queue of 4); a call that never got its turn gives its budget slot back.
- The denial circuit and the session write tracker keep at most 512 sessions (least recently used dropped), and forget sessions the review service evicts.

### Service transport

- Host calls fail after 30 s and past 64 in flight; all pending calls fail when the host closes the connection.
- Incoming frames are cut from raw bytes at the host's 1 MiB limit; an oversized frame is skipped to its newline. Requests beyond 64 running handlers are answered busy.
- A frame over 1 MiB is never written (an answer becomes an error, a host call fails, an event is dropped with a warning). While the host is not reading, frames wait for `drain` and waiting events and logs are capped at 8 MiB, oldest first; answers and host calls are never dropped.
- On shutdown or end of input the service takes no new work and lets running handlers answer during a short drain.
