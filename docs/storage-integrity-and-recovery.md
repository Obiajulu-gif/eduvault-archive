# Storage Integrity and Recovery System

This document covers the four interconnected systems for maintaining IPFS/Pinata storage reliability: pin verification, garbage collection, chunked uploads, and content integrity verification.

## Overview

EduVault stores educational content on IPFS via Pinata. This system ensures:
- **Pin health**: Pinned content remains retrievable
- **Integrity**: Content matches what was uploaded
- **Efficiency**: Orphaned/failed uploads are cleaned up
- **Scalability**: Large files can be uploaded reliably

## Issue #738: Pin Verification and Repair

### Purpose
Verify that content pinned to Pinata is still retrievable via gateways, and repair or notify if pins become unreachable.

### Key Components

#### PinHealthStatus
- `healthy`: Content accessible on all/most gateways
- `degraded`: Content accessible on some gateways
- `unreachable`: Content not accessible anywhere
- `unknown`: Never checked or check failed

#### Architecture
```
verifyPinRetrievability()
  ├─ Samples gateways (multiple attempts to reduce false positives)
  ├─ Updates material storage.pinHealth
  └─ Records failures for repair

updateMaterialPinHealth()
  └─ Persists health status to MongoDB

suggestRepairAction()
  └─ Determines if repair, notification, or flag is needed
```

### Database Schema
```javascript
material.storage = {
  cid: "QmXxx...",
  pinHealth: {
    status: "healthy|degraded|unreachable",
    lastVerified: ISODate(),
    verificationDetails: "...",
    gatewayResults: [
      { provider: "pinata", status: 200, ok: true },
      { provider: "secondary", status: 504, ok: false },
    ],
  },
  requiresRepair: false,
  repairAttempts: {
    count: 0,
    lastAttempt: ISODate(),
    nextRetry: ISODate(),
  },
}
```

### Usage

#### Run verification (10% sampling rate)
```bash
curl -X POST http://localhost:3000/api/admin/storage-jobs \
  -H "x-admin-token: $ADMIN_API_TOKEN" \
  -d '{"action": "verify-pins", "options": {"samplingRate": 0.1}}'
```

#### Run repairs
```bash
curl -X POST http://localhost:3000/api/admin/storage-jobs \
  -H "x-admin-token: $ADMIN_API_TOKEN" \
  -d '{"action": "repair-pins", "options": {"maxRepairs": 10}}'
```

#### Check status
```bash
curl -X GET "http://localhost:3000/api/admin/storage-jobs?status=pin-health" \
  -H "x-admin-token: $ADMIN_API_TOKEN"
```

---

## Issue #739: Garbage Collection

### Purpose
Safely identify and unpin content that is no longer referenced (abandoned drafts, deleted listings, failed uploads).

### Key Concepts

#### UploadState
- `draft`: Material created but not yet published
- `published`: Listed on marketplace
- `deleted`: Explicitly removed
- `failed`: Upload or creation failed

#### Policy
- Drafts expire after 24 hours
- Failed uploads cleaned up after 6 hours  
- Deleted materials have 72-hour grace period
- Minimum 1 hour age before GC considers a pin

### Architecture
```
identifyOrphanedCids()
  ├─ Scans materials for all CIDs (main + thumbnail)
  ├─ Categorizes by state (published, draft, deleted)
  └─ Returns list of orphaned CIDs with reason

performGarbageCollection()
  ├─ Checks if dry-run or live
  ├─ Calls unpinCid() for each orphan
  └─ Logs actions to gc_audit_log

recordGCAction()
  └─ Persists GC attempt to audit trail
```

### Database Schema
```javascript
material.storage = {
  cid: "QmXxx...",
  markedForGC: false,
  gcReason: "Draft not published for 24.5h",
  gcMarkedAt: ISODate(),
}

gc_audit_log = {
  _id: ObjectId(),
  cid: "QmXxx...",
  action: "gc_attempt",
  result: "unpinned|error",
  details: "...",
  timestamp: ISODate(),
  dryRun: false,
}
```

### Usage

#### Dry-run (safe to inspect results)
```bash
curl -X POST http://localhost:3000/api/admin/storage-jobs \
  -H "x-admin-token: $ADMIN_API_TOKEN" \
  -d '{"action": "garbage-collection", "options": {"dryRun": true}}'
```

#### Live cleanup (requires performCleanup flag)
```bash
curl -X POST http://localhost:3000/api/admin/storage-jobs \
  -H "x-admin-token: $ADMIN_API_TOKEN" \
  -d '{
    "action": "garbage-collection",
    "options": {
      "dryRun": false,
      "performCleanup": true,
      "limit": 50
    }
  }'
```

#### Check metrics
```bash
curl -X GET "http://localhost:3000/api/admin/storage-jobs?status=gc-status" \
  -H "x-admin-token: $ADMIN_API_TOKEN"
```

---

## Issue #740: Chunked, Resumable Uploads

### Purpose
Support large files (multi-GB) by breaking uploads into chunks, allowing pause/resume and progress tracking.

### Key Components

#### UploadSessionManager
Manages upload lifecycle:
- Create session with total chunk count
- Record progress as chunks upload
- Track failures and retry state
- Finalize and verify reassembly

#### States
- `initialized`: Session created, no chunks uploaded
- `in_progress`: Chunks being uploaded
- `paused`: User paused upload
- `completed`: All chunks verified
- `failed`: Upload failed, not recoverable

### Architecture
```
POST /api/upload/chunked?action=create-session
  └─ Returns sessionId + uploadToken + presigned URLs for chunks

POST /api/upload/chunked?action=upload-chunk
  └─ Client uploads chunk to S3-compatible storage
  ├─ Server records chunk hash + state
  └─ Returns progress

POST /api/upload/chunked?action=finalize-upload
  ├─ Verifies all chunks present
  ├─ Computes manifest hash from chunk hashes
  └─ Returns ready for pinning

GET /api/upload/chunked?sessionId=...
  └─ Returns upload progress
```

### Database Schema
```javascript
upload_sessions = {
  _id: "session_...",
  uploadToken: "token_...",
  fileMetadata: { fileName, size, mimeType, chunkSize },
  totalChunks: 1024,
  completedChunks: 512,
  uploadedBytes: 2684354560,
  totalBytes: 5368709120,
  state: "in_progress",
  creatorAddress: "0x...",
  createdAt: ISODate(),
  lastActivityAt: ISODate(),
  expiresAt: ISODate(), // 7-day TTL
}

upload_chunks = {
  _id: "session_..._chunk_0",
  sessionId: "session_...",
  chunkIndex: 0,
  chunkHash: "sha256:...",
  chunkSize: 5242880,
  state: "uploaded|verified",
  uploadedAt: ISODate(),
}
```

### Usage

#### Initiate chunked upload
```bash
curl -X POST "http://localhost:3000/api/upload/chunked?action=create-session" \
  -H "x-wallet-address: 0x..." \
  -d '{
    "fileName": "large-course-1.mp4",
    "fileSize": 5368709120,
    "chunkSize": 5242880,
    "mimeType": "video/mp4"
  }'
```

#### Get progress
```bash
curl -X GET "http://localhost:3000/api/upload/chunked?sessionId=session_..." \
  -H "x-wallet-address: 0x..."
```

#### Pause upload
```bash
curl -X POST "http://localhost:3000/api/upload/chunked?action=pause-upload" \
  -d '{"sessionId": "session_..."}'
```

#### Resume upload
```bash
curl -X POST "http://localhost:3000/api/upload/chunked?action=resume-upload" \
  -d '{"sessionId": "session_...", "uploadToken": "token_..."}'
```

#### Finalize upload
```bash
curl -X POST "http://localhost:3000/api/upload/chunked?action=finalize-upload" \
  -d '{
    "sessionId": "session_...",
    "uploadToken": "token_...",
    "fileHash": "sha256:..."
  }'
```

---

## Issue #741: Content Integrity Verification

### Purpose
Store content hashes at upload time and verify retrieved content matches via sampling, detecting silent corruption or tampering.

### Key Concepts

#### IntegrityStatus
- `verified`: Retrieved content matches stored hash
- `mismatch`: Hash doesn't match (corruption/tampering)
- `unreachable`: Content couldn't be fetched
- `unknown`: Never checked or check failed

#### Sampling
- Default 5% sampling rate per batch
- Reduces load while maintaining coverage
- Configurable per check run

### Architecture
```
storeContentHash()
  ├─ Computed at upload time
  └─ Stored alongside CID

sampledVerifyMaterial()
  ├─ Random sampling decision
  ├─ Fetches from gateway
  ├─ Computes hash
  └─ Compares to stored hash

recordIntegrityFailure()
  ├─ Logs to integrity_failures
  ├─ Marks material as requiring attention
  └─ Queues remediation action

suggestRemediationPath()
  ├─ Checks for existing purchases
  └─ Recommends notify or re-upload
```

### Database Schema
```javascript
material.storage = {
  cid: "QmXxx...",
  contentHash: "sha256:...",
  hashAlgorithm: "sha256",
  hashComputedAt: ISODate(),
  integrityIssue: false,
  lastIntegrityFailure: ISODate(),
}

integrity_failures = {
  _id: ObjectId(),
  materialId: ObjectId(),
  cid: "QmXxx...",
  computedHash: "sha256:...",
  storedHash: "sha256:...",
  status: "mismatch|unreachable",
  details: "...",
  timestamp: ISODate(),
  resolved: false,
  resolvedAt: ISODate(),
  resolvedReason: "...",
}
```

### Usage

#### Run integrity verification (5% sampling)
```bash
curl -X POST http://localhost:3000/api/admin/storage-jobs \
  -H "x-admin-token: $ADMIN_API_TOKEN" \
  -d '{"action": "verify-integrity", "options": {"samplingRate": 0.05}}'
```

#### Check integrity health
```bash
curl -X GET "http://localhost:3000/api/admin/storage-jobs?status=integrity-health" \
  -H "x-admin-token: $ADMIN_API_TOKEN"
```

---

## Scheduling and Monitoring

### Recommended Schedule
```
Pin Verification:
  - Every 6 hours (10% sampling)
  - Repairs: Hourly if failures detected

Garbage Collection:
  - Daily at 2 AM UTC (dry-run)
  - Weekly cleanup run (if approved)

Integrity Verification:
  - Continuous (5% sampling per batch)
  - Batch size: 50-100 materials

Cleanup Expired Sessions:
  - Hourly (removes >7 day old sessions)
```

### Monitoring Points
1. Pin failure rate (alert if > 1%)
2. Garbage collection metrics (monthly storage saved)
3. Integrity failure rate (alert if > 0.1%)
4. Chunked upload session success rate

### Alerts
- Material unreachable for 24h+ → Notify creator
- Integrity mismatch → Mark listing degraded
- GC errors → Review audit log
- Multiple repair failures → Escalate to review

---

## Environment Variables

```bash
PINATA_JWT=<JWT token>
NEXT_PUBLIC_GATEWAY_URL=<gateway URL>
SECONDARY_PINNING_ENDPOINT=<backup pinning service>
SECONDARY_PINNING_TOKEN=<auth token>
SECONDARY_IPFS_GATEWAY=<backup gateway URL>
ADMIN_API_TOKEN=<secret admin token>
UPLOAD_ENDPOINT=<S3-compatible upload URL>
```

---

## Error Handling

### Pin Verification
- Transient 504/timeout: Retry with exponential backoff
- Persistent 404: Material likely unpinned
- Multiple gateway failures: Flag as degraded

### Garbage Collection
- Never unpin without double-checking material state
- Dry-run always before live execution
- Log all actions to audit trail

### Integrity Verification
- Sampling prevents false positives from network blips
- Multiple gateway checks before declaring failure
- Creator notification before any destructive action

### Chunked Uploads
- 7-day session expiration prevents resource leaks
- Resume capability survives page refreshes
- Hash verification before finalization

---

## Testing

### Unit Tests
```bash
npm run test src/lib/storage/
npm run test src/lib/workers/
```

### Integration Tests
```bash
# Test pin verification with mock gateways
npm run test:integration -- --grep "pin-verification"

# Test GC with test materials
npm run test:integration -- --grep "garbage-collection"

# Test chunked upload session management
npm run test:integration -- --grep "chunked-upload"

# Test integrity verification
npm run test:integration -- --grep "integrity-verification"
```

### Manual Testing

#### Create test data
```javascript
const db = await getDb();
const materials = db.collection('materials');

// Create draft material
await materials.insertOne({
  title: 'Test Draft',
  state: 'draft',
  creatorAddress: '0x...',
  storage: {
    cid: 'QmTest...',
    thumbnailCid: 'QmThumb...',
  },
  createdAt: new Date(Date.now() - 25 * 3600000), // 25 hours ago
});
```

#### Run jobs manually
```bash
# In admin panel or directly:
POST /api/admin/storage-jobs
{
  "action": "garbage-collection",
  "options": { "dryRun": true }
}
```

---

## References

- [Pinata API Docs](https://docs.pinata.cloud)
- [IPFS Concepts](https://docs.ipfs.tech)
- [Content Addressing](https://docs.ipfs.tech/concepts/content-addressing/)
- [Pinning Services Spec](https://ipfs.github.io/pinning-services-api-spec/)
