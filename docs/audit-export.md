# Deterministic audit exports

`src/lib/audit/auditExport.js` produces versioned audit evidence with one of the
`full`, `security_incident`, `operations`, or `privacy_review` profiles. Staff
authorization is checked before records are read. Non-full profiles replace
credential-like fields and profile-specific sensitive fields with the stable
`[REDACTED]` marker.

Every export includes a deterministic export id for the same timestamp, profile,
and content, plus a SHA-256 content hash and record count. Consumers can call
`verifyAuditExport()` without database access. Empty exports are valid and still
carry verification metadata.
