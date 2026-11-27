# Contributor Diagnostics Command

**Issue #1154** — `scripts/contributor-diagnostics.mjs` & `src/lib/health/contributorDiagnostics.js`

## Overview

The `diagnostics:contributor` command provides local environment verification, runtime inspection, dependency reachability checks, and actionable remediation instructions for EduVault contributors.

All output strictly redacts sensitive credentials, connection strings, secret tokens, and Stellar private keys. The output is safe to paste into issues, PR discussions, and Discord support channels.

---

## Usage

```bash
# Run human-readable diagnostics
npm run diagnostics:contributor

# Run in machine-readable JSON mode (safe to attach to bug reports)
npm run diagnostics:contributor -- --json

# Retry transient/network dependencies up to 3 times with exponential backoff
npm run diagnostics:contributor -- --retries=3

# Strict mode: fail with exit code 1 on degraded services as well as misconfigured
npm run diagnostics:contributor -- --strict

# Minimal output (status summary only)
npm run diagnostics:contributor -- --quiet

# View help and options
npm run diagnostics:contributor -- --help
```

---

## Checked Components

1. **Runtime & Tooling:**
   - Node.js version and compatibility check (requires `>=20.0.0` for full production parity).
   - Platform OS (`win32`, `linux`, `darwin`) and CPU architecture.
   - Lockfile presence (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`).
2. **Environment Variables Presence:**
   - `MONGODB_URI`
   - `PINATA_JWT`
   - `NEXT_PUBLIC_STELLAR_RPC_URL`
   - `NEXT_PUBLIC_HORIZON_URL`
   - `NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID`
   - `NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID`
   *(Evaluated as boolean presence only; values are never printed).*
3. **External Dependencies:**
   - MongoDB database connectivity ping.
   - Pinata IPFS authentication.
   - Stellar Horizon and Soroban RPC endpoint accessibility.
   - Local mock or live SMTP email service.
   - On-chain Soroban contract deployment status.

---

## Execution Paths (#1154)

### 1. Normal Path
- Executes all dependency checks sequentially or aggregates provided dependency reports.
- Formats status as `HEALTHY`, `DEGRADED`, `UNAVAILABLE`, or `MISCONFIGURED`.
- Returns exit code `0` if all services are healthy (or degraded without `--strict`).

### 2. Failure Path
- **Misconfigured:** If required environment variables are missing or use invalid protocols (e.g. `http://` instead of `mongodb://`), reports `MISCONFIGURED` and exits with code `1`.
- **Incompatible Node Version:** Warns if the installed Node version is below version 20.
- **Remediation hints:** Every failing dependency provides specific, step-by-step resolution hints.

### 3. Retry Path
- Network-dependent external services (Stellar RPC, Pinata gateway, MongoDB ping) can experience transient timeouts.
- When `--retries=<n>` is specified, the runner retries up to `n` times with exponential backoff (`retryDelayMs * 2^(attempt - 1)`).
- When a service remains unreachable, the report marks `retryable: true`, distinguishing network blips from permanent configuration errors.

### 4. Authorization Path
- By default, local execution runs in contributor mode without elevated credentials.
- When invoked programmatically or in operator contexts, `assertContributorDiagnosticsAuthorized(actor)` verifies caller credentials.
- Permitted roles: `contributor`, `operator`, `admin`, and `service`. Unauthorized callers receive `ContributorDiagnosticsAuthorizationError` (HTTP 403).

---

## Edge Cases, Recovery & Rollback

- **Offline / Air-Gapped Development:** If working offline, Stellar and Pinata checks will report `UNAVAILABLE` (`retryable: true`). Local mock fallbacks allow continuing frontend development.
- **Placeholder Values:** Environment variables containing placeholder values (such as `YOUR_PINATA_JWT` or `mongodb://localhost`) are detected and flagged as `MISCONFIGURED`.
- **Zero State Impact:** Diagnostics are completely read-only and generate no side-effects or persistent database changes. Rollback is immediate by clearing CLI flags or environment overrides.

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
