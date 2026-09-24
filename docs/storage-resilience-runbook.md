# Storage resilience and quota runbook

New uploads require matching CIDs from two independent pinning services. Configure
Pinata plus `SECONDARY_PINNING_ENDPOINT`, `SECONDARY_PINNING_TOKEN`, and
`SECONDARY_IPFS_GATEWAY`. Gateway resolution probes providers in order and falls
back when the preferred gateway is degraded.

Schedule `POST /api/internal/storage-quota` with `Authorization: Bearer
$CRON_SECRET`. Each poll is retained in `storage_quota_history`; at 80% projected
usage it sends `storage_quota_warning` to `STORAGE_ALERT_WEBHOOK_URL`. At 100%,
uploads stop before any pin starts and return a retryable 503.

## Incident response

1. Confirm billing and quota status in both provider consoles.
2. Pause large creator imports while capacity is increased.
3. Verify recent CIDs through both gateways before reopening uploads.
4. Review `storage_quota_history` to estimate runway and adjust alert thresholds.

## Existing-content backfill

Export Pinata's CID inventory in batches, fetch each CID through a verified
gateway, pin it to the secondary provider, and record successful replicas. Retry
failures with bounded backoff and reconcile both inventories before declaring the
backfill complete.

Dual pinning approximately doubles stored-byte charges and adds one provider API
request per object plus health probes. Track monthly byte growth from
`storage_quota_history` and compare both providers' invoice totals before changing
retention or replication policy.
