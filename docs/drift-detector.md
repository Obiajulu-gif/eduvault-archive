# Cross-Environment Configuration Drift Detector (#875)

`src/lib/config/driftDetector.js` and `scripts/config-drift.mjs` provide a way to compare configuration across environments (local, staging, production) to identify missing keys, mismatched values, and unexpected drift before it causes inconsistent behavior.

## Quick Start

```bash
# Compare current process env (inferred) against production
npm run config:drift -- --baseline production --target staging

# Compare two .env files
npm run config:drift -- --baseline .env.production --target .env.staging --file

# Compare production against multiple environments
npm run config:drift -- --baseline production --target staging --target development --json

# Compare specific keys only
npm run config:drift -- --baseline production --target staging --keys JWT_SECRET,MONGODB_URI,NEXT_PUBLIC_APP_URL
```

## Architecture

The drift detector works by:

1. **Loading configurations** - From process.env (with `EDUVAULT_DEPLOY_ENV` for environment inference) or from `.env` files
2. **Comparing keys** - All known configuration keys are compared (from `CONFIG_CONTRACT` + additional known keys)
3. **Classifying differences** - Each difference is classified as:
   - **Matching** - Same value in both environments
   - **Allowed difference** - Expected to differ (network URLs, contract IDs, secrets, feature flags, etc.)
   - **Missing** - Key present in one environment but not the other
   - **Mismatched (unexpected drift)** - Different values for keys that should be the same
4. **Redacting secrets** - All secret values are redacted in output (shows only first 4 and last 4 chars)
5. **Reporting** - Human-readable or JSON output with summary and details

## Allowed Differences (Expected Drift)

The following configuration differences are documented and expected between environments:

| Rule | Keys | Description |
|------|------|-------------|
| `network` | `NEXT_PUBLIC_STELLAR_NETWORK` | TESTNET vs PUBLIC |
| `network-url` | `NEXT_PUBLIC_STELLAR_RPC_URL`, `NEXT_PUBLIC_HORIZON_URL`, `NEXT_PUBLIC_EXPLORER_URL` | Different network endpoints |
| `contract-id` | `NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID`, `NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID`, `NEXT_PUBLIC_SOROBAN_CONTRACT_ID` | Different contract IDs per deployment |
| `app-url` | `NEXT_PUBLIC_APP_URL` | Base URL differs per environment |
| `database-uri` | `MONGODB_URI` | Different database connections |
| `gateway-url` | `NEXT_PUBLIC_GATEWAY_URL`, `SECONDARY_IPFS_GATEWAY` | Different IPFS gateways |
| `sandbox-flag` | `EDUVAULT_SANDBOX` | Enabled in local/test, disabled in deployed |
| `fee-tuning` | `STELLAR_SURGE_FEE_THRESHOLD`, `STELLAR_SURGE_FEE_MULTIPLIER`, etc. | Fee parameters may be tuned |
| `tuning-parameter` | `RECOVERY_LOOKBACK_LEDGERS`, `MONGODB_MAX_POOL_SIZE`, etc. | Various tuning parameters |
| `refund-policy` | `REFUND_WINDOW_DAYS`, `REFUND_MAX_RETRY_ATTEMPTS`, etc. | Refund policy may differ |
| `feature-flag` | `FEATURE_FLAG_*` | Feature flags rolled out differently |
| `horizon-failover` | `STELLAR_HORIZON_FALLBACKS`, etc. | Horizon failover settings |
| `secret-per-environment` | All secret keys | Each environment has its own secrets |
| `node-env` | `NODE_ENV` | development/test/ci vs staging/production |
| `deploy-env` | `EDUVAULT_DEPLOY_ENV` | Explicit deployment environment |

## Secret Redaction

All secret values are automatically redacted in output:

```
JWT_SECRET: jwt-****xxxx  (shows only first 4 and last 4 characters)
```

Secrets are never included in:
- Console output
- JSON output
- Formatted reports

This applies to:
- `JWT_SECRET`, `PINATA_JWT`, `STELLAR_WEBHOOK_SECRET`, `CRON_SECRET`
- `DOWNLOAD_CAPABILITY_SECRET`, `CONTENT_MANIFEST_SECRET`, `UNSUBSCRIBE_TOKEN_SECRET`
- `ANALYTICS_HASH_SECRET`, `STELLAR_ADMIN_SECRET`, `EMAIL_PASS`, `SMTP_PASS`
- `SECONDARY_PINNING_TOKEN`, `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`, `WEBHOOK_URL`
- `STELLAR_ADMIN_PUBLIC_KEY`

## CLI Reference

```
config-drift --baseline <env|file> --target <env|file> [options]

Required:
  --baseline <name|path>    Baseline environment name or .env file path
  --target <name|path>      Target environment name or .env file path (repeatable)

Options:
  --file                    Treat --baseline and --target as file paths
  --json                    Output machine-readable JSON
  --verbose                 Show matching keys in output
  --no-color                Disable ANSI colors
  --no-redact               Show secret values (DANGEROUS - for debugging only)
  --keys <list>             Comma-separated list of keys to compare (default: all known)
  --help                    Show this help

Environment names: development, test, ci, staging, production

Exit codes:
  0 — No unexpected drift
  1 — Drift detected (mismatched or missing keys)
  2 — Usage error
```

## JSON Output Format

```json
{
  "baseline": "production",
  "comparisons": [
    {
      "target": "staging",
      "summary": {
        "totalCompared": 85,
        "matching": 45,
        "missingInBaseline": 0,
        "missingInTarget": 5,
        "mismatched": 0,
        "allowedDifferences": 35,
        "hasCriticalDrift": false,
        "hasHighDrift": false
      },
      "missingInBaseline": [],
      "missingInTarget": [
        { "key": "UNSUBSCRIBE_TOKEN_SECRET", "production": "unsu****xxxx", "severity": "high" }
      ],
      "mismatched": [],
      "allowedDifferences": [
        {
          "key": "NEXT_PUBLIC_STELLAR_NETWORK",
          "production": "PUBLIC",
          "staging": "TESTNET",
          "rule": "network",
          "description": "Stellar network differs between testnet..."
        }
      ],
      "matching": 45
    }
  ]
}
```

## Integration with Config Contract

The drift detector complements the configuration contract (`configContract.js`):

- **Config Contract** - Validates a single environment's configuration against requirements
- **Drift Detector** - Compares two environments to find unexpected differences

Both use the same `CONFIG_CONTRACT` as the source of truth for known keys.

## Examples

### Detect missing production keys in staging

```bash
npm run config:drift -- --baseline production --target staging
```

Output shows `UNSUBSCRIBE_TOKEN_SECRET` missing in staging (required in production only).

### Verify local development matches production structure

```bash
npm run config:drift -- --baseline production --target development
```

Shows allowed differences (network, database, sandbox) and missing production-only keys.

### CI/CD Integration

Add to your deployment pipeline:

```yaml
- name: Check configuration drift
  run: npm run config:drift -- --baseline production --target staging --json
```

## Extending Allowed Differences

To add a new allowed difference, edit `ALLOWED_DIFFERENCES` in `src/lib/config/driftDetector.js`:

```javascript
{
  keys: ['YOUR_NEW_KEY'],
  rule: 'your-rule-name',
  description: 'Human-readable description',
  compare: (a, b) => {
    // Return true if the difference is allowed
    return a === b || customLogic(a, b);
  },
}
```

## Files

- `src/lib/config/driftDetector.js` - Core detection logic
- `src/lib/config/__tests__/driftDetector.test.js` - Unit tests (64 tests)
- `scripts/config-drift.mjs` - CLI command
- `docs/drift-detector.md` - This documentation