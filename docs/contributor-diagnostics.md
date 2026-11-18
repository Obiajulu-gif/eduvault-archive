# Contributor diagnostics

Run `npm run diagnostics:contributor -- --json` when local setup or dependency checks fail. The report combines runtime details, presence-only environment checks, dependency health, and remediation hints. Values are never printed, so it is safe to attach the JSON report to a support request. An unavailable service is retryable; a misconfigured dependency requires updating local configuration.

## Local setup failures (#1079)

When `npm run dev`, `npm test`, or `npm ci` fails before any service is involved, run:

```bash
npm run diagnostics:setup            # text report
npm run diagnostics:setup -- --json  # attach this to a support request
npm run diagnostics:setup -- --offline  # skip the MongoDB connection probe
```

Implementation: `src/lib/health/setupFailureDiagnostics.js`. Tests: `tests/backend/setup-failure-diagnostics.test.mjs`.

### What is checked

| Code | Category | Meaning |
| --- | --- | --- |
| `NODE_VERSION_UNSUPPORTED` | runtime | Node.js older than 20 (the CI version) |
| `NOT_REPOSITORY_ROOT` | configuration | Not run from the checkout root; other checks are skipped |
| `NPM_LOCKFILE_MISSING` / `CONFLICTING_LOCKFILES` | dependencies | No `package-lock.json`, or a pnpm/yarn lockfile next to it |
| `DEPENDENCIES_NOT_INSTALLED` | dependencies | `node_modules` is missing |
| `ENV_FILE_MISSING` / `ENV_FILE_UNREADABLE` | configuration / authorization | No `.env.local` (and nothing exported), or it cannot be read |
| `ENV_REQUIRED_MISSING` | configuration | `NEXT_PUBLIC_APP_URL`, `MONGODB_URI` or `JWT_SECRET` is empty |
| `ENV_PLACEHOLDER_VALUE` | configuration | A value is still the `.env.example` placeholder |
| `MONGODB_URI_MALFORMED` | configuration | Not a `mongodb://` or `mongodb+srv://` URI |
| `STORAGE_NOT_CONFIGURED` | configuration | No `PINATA_JWT` and `EDUVAULT_SANDBOX` is not `true` |
| `SERVICE_UNREACHABLE` | connectivity | The MongoDB probe could not connect (retryable) |
| `CREDENTIALS_REJECTED` / `PERMISSION_DENIED` | authorization | A service rejected credentials, or the OS denied file/port access |
| `PORT_IN_USE`, `HOST_NOT_FOUND`, `MODULE_MISSING`, `UNCLASSIFIED` | various | Classified from error codes by `classifySetupError` |

### Exit codes and retry

| Status | Exit code | When |
| --- | --- | --- |
| `ready` | 0 | Nothing failed |
| `action_required` | 1 | At least one failure needs a change from you |
| `retry_later` | 75 (`EX_TEMPFAIL`) | Only connectivity failures, for example MongoDB still starting |

The MongoDB probe retries connectivity failures up to three times with exponential backoff (250 ms, 500 ms). Authorization failures are never retried, so a wrong password cannot lock an account through repeated attempts. Unknown errors are not retried either.

### Edge cases

- Variables exported in the shell override `.env.local`, which matches how Next.js loads env files. A fully exported environment without `.env.local` is valid.
- `mongodb+srv://` URIs are not probed (DNS SRV resolution is left to the driver); use `npm run diagnostics:contributor` for a full dependency check.
- Credentials in error messages and URIs are redacted with `sanitizeDiagnostics` before anything is printed.

### Recovery

The tool is read-only: it never installs, writes, or starts anything. Every failure carries one `fix:` line. Apply the fixes and rerun until the status is `ready`.

### Compatibility

`npm run diagnostics:contributor` without `--setup` keeps its existing output, JSON shape, and exit codes (1 only when misconfigured). `collectContributorDiagnostics` and `runContributorDiagnostics` are unchanged.
