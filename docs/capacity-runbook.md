# Capacity Runbook

Maps saturation signals to scaling and mitigation actions for the EduVault platform.

## System Architecture Overview

```
Client → Next.js API Routes → withApiHardening
                                  ├── Rate Limiting (per-key sliding window)
                                  ├── Load Shedding (priority-based)
                                  ├── Payload Size Check
                                  ├── Concurrency Admission Control
                                  └── Client Disconnect Signal
                                     ├── MongoDB (connection pool)
                                     ├── IPFS/Pinata (file upload/retry)
                                     ├── Stellar Horizon (RPC, failover)
                                     └── Stellar Soroban (contract calls)
```

## Capacity Model

### Route Priority Tiers

| Priority | Routes | Behavior Under Pressure |
|----------|--------|------------------------|
| **0 (Critical)** | `/api/purchase`, `/api/download`, `/api/entitlements`, `/api/checkout/verify` | **Never shed.** Protected at all costs. |
| **1 (High)** | `/api/upload`, `/api/materials` (POST/PUT/PATCH) | Shed at 50% system pressure. |
| **2 (Medium)** | `/api/market-materials`, `/api/reviews/publish`, `/api/materials` (GET), `/api/provenance/version` | Shed at 30% system pressure. |
| **3 (Low)** | `/api/health`, `/api/metrics`, `/api/provenance/backfill | Shed at 10% system pressure. |

### Per-Route Limits

| Route | Max Concurrent | Max Queue | Timeout | Max Payload |
|-------|---------------|-----------|---------|-------------|
| `POST /api/purchase` | 20 | 40 | 15s | 64KB |
| `GET /api/download` | 30 | 60 | 30s | — |
| `GET /api/entitlements` | 25 | 50 | 8s | — |
| `POST /api/checkout/verify` | 15 | 30 | 10s | 8KB |
| `POST /api/upload` | 10 | 20 | 60s | 15MB |
| `POST /api/materials` | 20 | 40 | 10s | 64KB |
| `GET /api/market-materials` | 30 | 60 | 8s | — |
| `GET /api/health` | 10 | 20 | 3s | — |

### System-Wide Limits

| Limit | Value | Description |
|-------|-------|-------------|
| Max concurrent requests | 200 | Global across all routes |
| Max MongoDB operations | 50 | Concurrent DB ops |
| Max outbound HTTP | 30 | RPC, IPFS, Horizon calls |
| Memory soft limit | 512MB | Begin monitoring |
| Memory hard limit | 768MB | Aggressive shedding |

## Saturation Signals

### 1. Memory Pressure

**Signal:** `capacity_pressure_memory` gauge, `process.memoryUsage().heapUsed`

| Level | Heap Used | Action |
|-------|-----------|--------|
| Normal | < 360MB | No action |
| Warning | 360–540MB (45–70%) | Monitor closely. Log warning. |
| Critical | > 540MB (>70%) | Shed priority 2+ routes. |
| Emergency | > 720MB (>90%) | Shed all non-critical. Restart if sustained. |

**Mitigation:**
- Check for memory leaks in long-running worker processes
- Reduce `MONGODB_MAX_POOL_SIZE` if connection pool is oversized
- Restart the Next.js process if heap doesn't stabilize

### 2. Concurrency Saturation

**Signal:** `capacity_inflight_global` gauge, `capacity_inflight_route` gauge

| Level | Global In-Flight | Action |
|-------|-----------------|--------|
| Normal | < 140 (<70%) | No action |
| Warning | 140–180 (70–90%) | Monitor route distribution |
| Critical | > 180 (>90%) | Shed priority 1+ routes |

**Mitigation:**
- Check for stuck requests (slow MongoDB queries, IPFS timeouts)
- Review `Retry-After` headers in client responses
- Scale horizontally if sustained

### 3. MongoDB Pool Exhaustion

**Signal:** `mongoPoolExhausted` pressure signal, driver connection events

**Indicators:**
- `serverSelectionTimeoutMS` errors in logs
- Connection checkout delays > 500ms
- `MongoNetworkError` or `MongoTimeoutError`

**Mitigation:**
1. Check MongoDB server status: `mongosh --eval "db.serverStatus().connections"`
2. Verify pool settings: `MONGODB_MAX_POOL_SIZE` (default: `cpus * 5`)
3. Check for slow queries: `db.currentOp({"secs_running": {"$gt": 5}})`
4. Kill long-running operations if safe
5. Scale MongoDB vertically (more connections) or horizontally (replica set)

### 4. Outbound HTTP Exhaustion

**Signal:** `outboundHttpExhausted` pressure signal

**Indicators:**
- Horizon failover cascading across all endpoints
- IPFS Pinata upload timeouts
- Stellar RPC `simulateTransaction` failures

**Mitigation:**
1. Check Horizon status: `curl https://horizon-testnet.stellar.org/`
2. Verify Pinata API status and quota
3. Reduce `STELLAR_HORIZON_RETRIES` temporarily
4. Enable circuit breaker for non-essential RPC calls

### 5. Queue Depth

**Signal:** `capacity_queue_full_total` counter, route queue sizes

| Route Queue | Threshold | Action |
|-------------|-----------|--------|
| Purchase queue > 40 | Critical | Shed all non-purchase traffic |
| Upload queue > 20 | Warning | Shed reviews, search |
| Any queue > 80% | Warning | Investigate slow handlers |

**Mitigation:**
- Check for downstream dependency slowdowns
- Review worker backlog in `sync_state` collection
- Reduce worker polling interval if backlog grows

## Fault Scenarios

### Scenario 1: Slow MongoDB

**Symptom:** Requests timing out at 8–15s, `MongoServerSelectionError`

**Diagnosis:**
```bash
# Check MongoDB server health
mongosh --eval "db.serverStatus()"

# Check for slow queries
mongosh --eval "db.currentOp({'secs_running': {'$gt': 5}})"

# Check connection pool stats
mongosh --eval "db.serverStatus().connections"
```

**Recovery:**
1. Kill long-running queries if safe
2. Reduce `MONGODB_MAX_POOL_SIZE` to prevent pool exhaustion
3. Scale MongoDB if sustained

### Scenario 2: Horizon RPC Failure

**Symptom:** `All Horizon requests failed after N attempts`

**Diagnosis:**
```bash
# Check each Horizon endpoint
curl -s https://horizon-testnet.stellar.org/ | jq .core_version
curl -s https://horizon.stellar.org/ | jq .core_version
```

**Recovery:**
1. Horizon SDK auto-failovers to backup endpoints
2. If all endpoints down, Stellar network may be degraded
3. Monitor `horizon_errors_total` metric
4. Reduce `STELLAR_HORIZON_TIMEOUT_MS` temporarily to fail faster

### Scenario 3: IPFS/Pinata Unavailable

**Symptom:** Upload route returning 503, pending_pins queue growing

**Diagnosis:**
```bash
# Check Pinata API status
curl -s https://api.pinata.cloud/health

# Check pending pins count
mongosh eduvault --eval "db.pending_pins.countDocuments({status: 'pending'})"
```

**Recovery:**
1. IPFS retry worker processes pending pins automatically
2. Monitor `pending_pins` collection depth
3. If Pinata is down, uploads are queued and retried
4. Upload route returns 202 with "pending" status to clients

### Scenario 4: Worker Backlog

**Symptom:** `sync_state` collection growing, workflows stuck in `pending`

**Diagnosis:**
```bash
# Check workflow states
mongosh eduvault --eval "db.sync_state.aggregate([{$group: {_id: '$state', count: {$sum: 1}}}])"

# Check worker logs
grep "\[Worker\]" /var/log/eduvault/worker.log | tail -50
```

**Recovery:**
1. Verify worker process is running: `ps aux | grep workflowWorker`
2. Check for stuck workflows: `db.sync_state.find({state: 'needs_reconciliation'}).limit(10)`
3. Restart worker if crashed
4. Manually confirm stuck workflows if needed

### Scenario 5: Memory Pressure

**Symptom:** `capacity_pressure_memory` > 0.7, requests being shed

**Diagnosis:**
```bash
# Check Node.js heap usage
node -e "console.log(process.memoryUsage())"

# Check for memory leaks
node --inspect server.js  # then use Chrome DevTools
```

**Recovery:**
1. Identify memory-intensive routes via `http_request_duration_ms` histogram
2. Check for unbounded caches (rate limiter buckets, metrics histograms)
3. Restart the process to reclaim memory
4. Increase `memorySoftLimitBytes` if sustained growth is expected

## Scaling Guidelines

### Horizontal Scaling

| Metric | Trigger | Action |
|--------|---------|--------|
| Global concurrency > 80% sustained | 5+ minutes | Add Next.js instances |
| MongoDB connections > 80% | 10+ minutes | Add replica set member |
| Queue depth > 50% sustained | 5+ minutes | Add worker processes |

### Vertical Scaling

| Metric | Trigger | Action |
|--------|---------|--------|
| Memory > 70% sustained | 10+ minutes | Increase instance memory |
| CPU > 70% sustained | 10+ minutes | Increase instance CPU |
| MongoDB latency > 100ms p95 | 5+ minutes | Upgrade MongoDB tier |

## Monitoring Dashboard

### Key Metrics to Watch

```
# Request metrics
http_requests_total{outcome="success"}
http_requests_total{outcome="rate_limited"}
http_requests_total{outcome="load_shed"}
http_requests_total{outcome="concurrency_rejected"}
http_request_duration_ms{quantile="0.95"}

# Capacity metrics
capacity_inflight_global
capacity_inflight_route{route="..."}
capacity_pressure_level
capacity_pressure_memory
capacity_pressure_concurrency
capacity_queue_full_total
capacity_load_shed_total

# Dependency metrics
mongodb_pool_connections
horizon_request_duration_ms
ipfs_upload_duration_ms
worker_jobs_total{outcome="..."}
```

### Alert Thresholds

| Alert | Condition | Severity |
|-------|-----------|----------|
| High error rate | `error_rate > 5%` for 5min | Warning |
| Elevated error rate | `error_rate > 15%` for 2min | Critical |
| Load shedding active | `load_shed_total > 0` for 5min | Warning |
| Memory critical | `pressure_memory > 0.8` for 5min | Critical |
| Concurrency saturated | `inflight_global > 180` for 2min | Critical |

## Recovery Checklist

After a capacity incident:

1. **Verify recovery:** All pressure signals return to normal
2. **Check data consistency:** No partial purchases or entitlements
3. **Review logs:** Identify root cause (slow query, dependency failure, traffic spike)
4. **Update budgets:** If limits were too conservative/aggressive
5. **Run load tests:** Verify fix handles expected load
6. **Document:** Add findings to this runbook

## Configuration Reference

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MONGODB_MAX_POOL_SIZE` | `cpus * 5` | Max MongoDB connections |
| `MONGODB_MIN_POOL_SIZE` | `min(cpus, maxPool)` | Min MongoDB connections |
| `MONGODB_TIMEOUT_MS` | `5000` | Server selection timeout |
| `STELLAR_HORIZON_TIMEOUT_MS` | `8000` | Horizon request timeout |
| `STELLAR_HORIZON_RETRIES` | `2` | Horizon retry count |
| `RUN_WORKER` | `false` | Enable background worker |
