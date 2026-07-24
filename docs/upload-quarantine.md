# Upload quarantine

Uploads are byte-sniffed, deduplicated by SHA-256, stored in quarantine, and
return `202` without a public URL. A separately deployed scan worker leases one
job at a time, runs without application or signing credentials, records engine
and rules versions, and approves or rejects the object. Archive entry, expanded
size, and nesting limits are enforced from scanner metadata. Failed scans remain
unavailable and retryable. Only approved objects may be published; rejection,
rescan, and maintainer override actions must be written to the audit log.
