# Distributed abuse protection

API hardening uses a Redis atomic increment/TTL script with bounded keys hashed
from endpoint, method, client IP, account, and wallet dimensions. Forwarded IP
headers are honored only when `TRUST_PROXY=true` and the deployment proxy is
configured to replace (not append untrusted) forwarding headers.

Read routes default to fail-open during a short Redis outage; state-changing
routes fail closed. Routes may override `outagePolicy`, `cost`, limit, and
window. Responses include standard limit metadata without logging raw wallet,
account, or IP values. Monitor degraded decisions and Redis latency.
