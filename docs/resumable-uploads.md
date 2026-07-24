# Resumable upload sessions

Create a session with `POST /api/upload/sessions`, an authenticated request,
an `Idempotency-Key` header, and the expected file name, MIME type, byte size,
and SHA-256 digest. Repeating the request returns the same session.

The client may upload directly or stream to the configured IPFS provider, then
records each durable CID with `PATCH /api/upload/sessions/:id` and action
`record-part`. Repeating an identical part is safe; conflicting content and
hash/size mismatches are rejected. `GET` resumes or inspects a session.

Action `complete` atomically claims a ready session and upserts exactly one
material by `uploadSessionId`. Action `cancel` races completion using a
conditional state update. A failure after any pin moves the session to
`cleanup_pending`; it never publishes a partial material.

Schedule `runUploadCleanup` with a provider-specific unpin adapter. Each pass
is bounded to 500 stale/cancelled sessions, records cleanup failures for retry,
and only marks a session cancelled after every tracked pin is removed. Audit
the worker result and alert on growing `cleanup_pending` counts.
