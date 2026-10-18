# Safe Public-Status Model for Degraded, Paused, or Maintenance States (#962)

## Overview
EduVault provides a public-facing health and status model that communicates system availability, subsystem incidents, and maintenance windows to users, creators, and operators while preventing the leakage of internal secrets, credentials, or topology.

## Core Capabilities

### 1. Leak-Proof Redaction Engine
Any error message, log entry, or diagnostic output exposed publicly is processed by `sanitizeText` and `sanitizeErrorMessage`:
- **Stellar Secret Seeds**: Alphanumeric secret seeds (`S[A-Za-z0-9]{50,60}`) are replaced with `[REDACTED_STELLAR_SECRET]`.
- **MongoDB Connection URIs**: URIs containing credentials (`mongodb://user:pass@host`) are sanitized to `mongodb://[REDACTED_CREDENTIALS]@host`.
- **JWT / Bearer Tokens**: Auth tokens are replaced with `[REDACTED_JWT]` or `[REDACTED_TOKEN]`.
- **Stack Traces & System Paths**: Full tracebacks and filesystem paths are stripped, returning clean single-line error descriptions.

### 2. Subsystem State Taxonomy
Each subsystem (`marketplace`, `checkout`, `indexer`, `entitlements`, `storage`, `webhooks`) can independently exist in one of four states:
- `operational`: Normal operation. Reads and writes permitted.
- `degraded`: Experiencing elevated latency or partial upstream failures. Reads and writes permitted with caution.
- `paused`: Mutating operations halted to protect against invariant breaches or sudden chain forks. Reads remain permitted.
- `maintenance`: Subsystem undergoing scheduled maintenance or schema upgrades. All traffic blocked (returns HTTP 503 with Retry-After).

### 3. Overall State Calculation
The overall system state derives deterministically from the highest-severity subsystem state:
```
maintenance > paused > degraded > operational
```

### 4. Cross-Path Operational Guards
- **API Guard**: Calling `assertSubsystemOperational(subsystem, 'write')` ensures mutations fail with clean HTTP 503 responses when a subsystem is paused or in maintenance.
- **Background Worker Guard**: Workers call `checkSubsystemAvailability(subsystem, 'write')` before processing jobs, safely yielding and preventing poison-pill crashes.
- **UI Exposure**: Available via `GET /api/status`, providing real-time incident status and active banners.

## Operational Runbook

### Changing Subsystem Status
To transition a subsystem status programmatically or via operator scripts:
```javascript
import { setSubsystemStatus, SUBSYSTEMS, SYSTEM_STATE } from '@/lib/status/publicStatusModel';

// Pause checkout during Soroban fee surge:
setSubsystemStatus(
  SUBSYSTEMS.CHECKOUT,
  SYSTEM_STATE.PAUSED,
  'Temporarily paused while investigating on-chain fee surge',
  'operator-oncall'
);

// Restore to operational:
setSubsystemStatus(
  SUBSYSTEMS.CHECKOUT,
  SYSTEM_STATE.OPERATIONAL,
  'Fee surge resolved; checkout re-enabled',
  'operator-oncall'
);
```

### Recovery & Reset
To instantly reset all subsystems to operational (e.g. after incident resolution):
```javascript
import { resetAllSubsystems } from '@/lib/status/publicStatusModel';
resetAllSubsystems();
```
