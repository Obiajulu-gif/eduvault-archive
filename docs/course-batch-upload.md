# Course batch upload and publication

Issue #765 is implemented as a manifest-first upload flow. A course is an
ordered collection of modules, not a single CID. `src/lib/upload/courseManifest.js`
creates the durable manifest and records each module independently:

```text
pending -> uploading -> verifying -> verified
                         \-> failed -> uploading (retry)
```

The manifest carries stable module ids, display order, relative path, byte
size, storage key, status, and a privacy-safe error code. Successful modules
are never re-uploaded when another module fails. Aggregate progress is
`verifiedBytes / totalBytes`; the UI should render both this value and each
module's state so a large course remains understandable on narrow screens.

`canPublishCourse()` is the server-side publication gate: every module must be
verified and have a storage key. A partial course remains an incomplete draft
and cannot enter marketplace discovery. The upload route should persist each
module's quarantine/verification result before calling the publication saga.

## Recovery and failure handling

- Retry only entries returned by `retryableCourseFiles()`.
- Keep successful CIDs and scan evidence immutable across retries.
- Use bounded module counts and aggregate byte limits at the API boundary.
- Never include file contents, secrets, or private media in error logs; use
  module id plus a stable error code.

The pure manifest tests cover ordering, partial failure, retry selection, the
publication gate, and duplicate paths.
