# External Dependency Health Checks & Network Assumptions

This document describes the external dependency health checking framework implemented for **EduVault** (Issue #843).

## Overview

EduVault interacts with critical external systems and network assumptions:
1. **Database (`database`)**: MongoDB database cluster storing student profiles, marketplace listings, purchases, outbox events, and audit logs.
2. **Storage (`storage`)**: Pinata IPFS service managing decentralized content hashing, file pinning, and public/dedicated gateway asset delivery.
3. **Stellar Network (`stellar`)**: Stellar Horizon REST API and Soroban RPC endpoints for blockchain querying, transactions, and contract state verification.
4. **Email / Notifications (`email`)**: Nodemailer / SMTP delivery for transactional receipts and welcome emails.
5. **Smart Contracts (`contracts`)**: Soroban smart contract configurations (`MATERIAL_REGISTRY_CONTRACT_ID`, `PURCHASE_MANAGER_CONTRACT_ID`, `SOROBAN_CONTRACT_ID`).

The dependency health check framework ensures:
- Missing, degraded, or misconfigured dependencies are detected before critical user flows fail unexpectedly.
- Four distinct dependency states are reported: `healthy`, `degraded`, `unavailable`, and `misconfigured`.
- Every issue provides clear, actionable remediation hints for maintainers and operators.
- **Zero secrets leakage guarantee**: Connection URIs, passwords, JWT tokens, Stellar secret keys, and EVM private keys are strictly redacted.

---

## Dependency States & Criteria

| State | Definition | Example Trigger | Remediation Guidance |
| :--- | :--- | :--- | :--- |
| `healthy` | Fully operational and responsive within performance thresholds. | MongoDB ping < 1500ms, Soroban RPC returns `healthy`, Pinata auth ok. | None required. |
| `degraded` | Operational with reduced capabilities, slow performance, or fallback mode. | Public Pinata gateway fallback in use, slow database latency (>1500ms), or email in dev mock mode. | Configure dedicated gateway or check network latency. |
| `unavailable` | Service is offline, unreachable, connection refused, or timed out. | MongoDB cluster unreachable, Horizon API down, or SMTP server rejecting auth. | Verify host/port availability, network firewalls, and server uptime. |
| `misconfigured` | Missing required environment variables, malformed URI, or invalid contract ID format. | `MONGODB_URI` missing, contract ID not a 56-char C-prefixed address. | Correct configuration in `.env` / environment secrets. |

---

## API Contract: `GET /api/health`

The health endpoint provides structured dependency health diagnostics for external monitoring, Kubernetes probes, and operators.

### Query Parameters
- `diagnostics=true`: Includes sanitized configuration indicators and environment flags.

### Response Schema (200 OK or 503 Service Unavailable)

```json
{
  "status": "healthy",
  "timestamp": "2026-10-17T20:30:00.000Z",
  "services": {
    "database": "online",
    "pinata": "online",
    "email": "online",
    "stellar": "online"
  },
  "dependencies": {
    "database": {
      "name": "database",
      "status": "healthy",
      "critical": true,
      "message": "MongoDB is connected and responsive.",
      "remediation": null,
      "latencyMs": 12
    },
    "storage": {
      "name": "storage",
      "status": "healthy",
      "critical": false,
      "message": "Pinata IPFS service authenticated and operational.",
      "remediation": null,
      "latencyMs": 85
    },
    "stellar": {
      "name": "stellar",
      "status": "healthy",
      "critical": true,
      "message": "Stellar Horizon and Soroban RPC endpoints are healthy.",
      "remediation": null,
      "latencyMs": 110
    },
    "email": {
      "name": "email",
      "status": "healthy",
      "critical": false,
      "message": "SMTP email connection verified and operational.",
      "remediation": null,
      "latencyMs": 45
    },
    "contracts": {
      "name": "contracts",
      "status": "healthy",
      "critical": false,
      "message": "Soroban smart contracts configured (2 active contract IDs).",
      "remediation": null,
      "latencyMs": null
    }
  },
  "remediations": [],
  "summary": {
    "total": 5,
    "healthy": 5,
    "degraded": 0,
    "unavailable": 0,
    "misconfigured": 0
  }
}
```

---

## Maintainer CLI Command

Contributors and maintainers can verify local or production dependency readiness directly via the command line:

```bash
# Human-readable formatted console report
npm run health:check
# Or directly via node
node scripts/check-dependency-health.mjs

# JSON machine-readable output (suitable for scripts and CI)
node scripts/check-dependency-health.mjs --json
```

---

## Secret Redaction & Sanitization Guarantees

All diagnostics output is sanitized through `sanitizeDiagnostics`:
- MongoDB URIs with credentials (`mongodb://user:pass@host`) are redacted to `mongodb://[REDACTED_CREDENTIALS]@host`.
- JWT tokens (`ey...`) are redacted to `[REDACTED_JWT]`.
- Stellar secret seeds (`S...`) are redacted to `[REDACTED_STELLAR_SECRET]`.
- EVM private keys (`0x...`) are redacted to `[REDACTED_EVM_PRIVATE_KEY]`.
- Any field named `password`, `secret`, `apiKey`, or `auth` is masked.

---

## Automated Tests

Run the dependency health test suite:

```bash
npx tsx --test tests/backend/dependencyHealth.test.mjs
```
