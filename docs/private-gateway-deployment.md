# Private Gateway Deployment Guide — Authenticated Streaming Delivery

This document describes how to deploy and configure the private IPFS gateway
that powers EduVault's authenticated streaming delivery system.

## Overview

The authenticated delivery architecture has three layers:

1. **Token Issuance** (`POST /api/delivery/token`) — Verifies entitlement and
   issues a short-lived, HMAC-signed token bound to the buyer + material + expiry.
2. **Streaming Proxy** (`GET /api/delivery/stream`) — Accepts the token, validates
   it, fetches the internal CID, and proxies file bytes through the server.
3. **Private IPFS Gateway** (Pinata Dedicated Gateway or self-hosted) — The
   upstream that actually serves the IPFS content. This gateway should **not**
   be publicly accessible, or if it is, should be locked down to the EduVault
   server's IP addresses.

## Prerequisites

- A Pinata account with Dedicated Gateway access (or a self-hosted IPFS gateway)
- EduVault server deployed and configured (see `docs/deployment.md`)
- MongoDB with `delivery_nonces` and `delivery_audit` collections

## Environment Variables

Set these in your production environment:

```bash
# Required: Pinata JWT for IPFS operations
PINATA_JWT=pinata_jwt_here

# Required: Private gateway URL (NOT the public one)
PRIVATE_IPFS_GATEWAY_URL=https://your-dedicated-gateway.mypinata.cloud

# Fallback public gateway (used only if PRIVATE_IPFS_GATEWAY_URL is unset)
NEXT_PUBLIC_GATEWAY_URL=https://gateway.pinata.cloud

# Required: Delivery token signing secret (generate with openssl)
DELIVERY_HMAC_SECRET=$(openssl rand -hex 32)

# Optional: Bind tokens to client IP (prevents token sharing)
DELIVERY_IP_BINDING=false

# Optional: Upstream timeout for streaming proxy
UPSTREAM_FETCH_TIMEOUT_MS=30000
```

## Pinata Dedicated Gateway Setup

### 1. Create a Dedicated Gateway

1. Log into [Pinata](https://app.pinata.cloud)
2. Navigate to **Gateways** → **Dedicated Gateways**
3. Create a new gateway with a unique subdomain (e.g., `eduvault-files.mypinata.cloud`)
4. Note the gateway URL — this becomes your `PRIVATE_IPFS_GATEWAY_URL`

### 2. Configure Gateway Access Controls

**Option A: IP Whitelist (Recommended)**

In the Pinata gateway settings, add IP whitelist entries for:

- All of your EduVault server's public IP addresses (IPv4 and IPv6)
- CI/CD runner IPs if you run integration tests

This ensures only your server can fetch content through the gateway.

**Option B: JWT Authentication**

If IP whitelisting isn't feasible (e.g., serverless with dynamic IPs):

1. Generate a gateway-specific JWT in Pinata settings
2. Pass it as a header in the streaming proxy:

   ```javascript
   // In src/lib/delivery/stream.js, add to upstreamHeaders:
   headers: {
     'Authorization': `Bearer ${process.env.PINATA_GATEWAY_TOKEN}`,
     'Accept': '*/*',
   }
   ```

3. Add `PINATA_GATEWAY_TOKEN` to your environment

### 3. Rate Limits

Pinata Dedicated Gateway limits:

| Tier       | Requests/sec | Bandwidth        |
|------------|-------------|------------------|
| Growth     | 100         | 1 TB/month       |
| Pro        | 500         | 5 TB/month       |
| Enterprise | Custom      | Custom           |

Configure `UPSTREAM_FETCH_TIMEOUT_MS` (default 30s) based on your expected
file sizes. Large files may need a longer timeout.

## CDN Configuration

### Cache Behavior

The streaming proxy sets these cache headers on all responses:

```
Cache-Control: private, no-cache, no-store, must-revalidate
```

This ensures:
- Responses are **not** cached by shared/CDN caches
- Each request goes through the token verification layer
- No cache leakage across users

### CDN Bypass

If using a CDN in front of EduVault (e.g., Cloudflare, Fastly):

1. **Do NOT cache** `/api/delivery/stream` responses
2. Configure a page rule / cache bypass for the `/api/delivery/*` path pattern
3. Do NOT cache `/api/delivery/token` POST responses

Example Cloudflare page rule:
```
URL: eduvault.example.com/api/delivery/*
Cache Level: Bypass
```

### CDN for Static Assets Only

You can still use a CDN for public static assets (images, CSS, JS).
The streaming delivery system only affects protected file delivery.

## MongoDB Indexes

For optimal performance, create these indexes:

```javascript
// Token nonces — TTL index auto-cleans used/expired nonces
db.delivery_nonces.createIndex(
  { expiresAt: 1 },
  { expireAfterSeconds: 0 }
);
db.delivery_nonces.createIndex(
  { nonce: 1 },
  { unique: true }
);

// Delivery audit — query by material/buyer
db.delivery_audit.createIndex(
  { materialId: 1, timestamp: -1 }
);
db.delivery_audit.createIndex(
  { buyerAddress: 1, timestamp: -1 }
);
db.delivery_audit.createIndex(
  { timestamp: -1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60 } // 90-day retention
);
```

## Security Considerations

### Token Security

- Tokens are HMAC-SHA256 signed with `DELIVERY_HMAC_SECRET`
- Default TTL is 15 minutes (configurable per-request, max 1 hour)
- Optional single-use nonce prevents replay attacks
- Optional IP binding prevents token sharing across networks
- Tokens are transmitted over HTTPS only

### CID Protection

- CIDs are stored server-side only
- Never returned to the client in API responses
- Streaming proxy fetches from private gateway
- Client only sees a short-lived token

### Audit Trail

Every delivery event is logged to `delivery_audit` collection:
- Token issuance (actor, material, IP, timestamp)
- Stream start (bytes requested, range)
- Stream errors (timeouts, disconnects, upstream failures)
- Access denials (invalid/expired tokens, no entitlement)

No secrets (CIDs, tokens, HMAC keys) are logged.

## Monitoring

### Key Metrics

Track these metrics to monitor delivery health:

1. **Token issuance rate** — Number of tokens issued per minute
2. **Stream success rate** — Successful streams / total stream attempts
3. **Upstream timeout rate** — Percentage of upstream fetch timeouts
4. **Average stream duration / size** — Performance baseline
5. **Token denial rate** — Invalid/expired token attempts (potential attack)

### Alerting Thresholds

Configure alerts for:

- Upstream timeout rate > 5% over 5 minutes
- Stream success rate < 95% over 10 minutes
- Token denial rate > 100/min (potential brute force)
- Average stream latency > 10 seconds

### Logs

Delivery audit logs are written to:
1. `delivery_audit` MongoDB collection (persistent, 90-day retention)
2. `stdout` via `console.info` with `[delivery-audit]` prefix (real-time)

## Troubleshooting

### "Upstream timeout" errors

1. Check `UPSTREAM_FETCH_TIMEOUT_MS` — increase if files are large
2. Verify `PRIVATE_IPFS_GATEWAY_URL` is reachable from the server
3. Check Pinata gateway status at https://status.pinata.cloud
4. Ensure server IP is whitelisted in Pinata gateway settings

### "Token expired" errors

1. Client-side: token was issued > 15 minutes ago
2. Client should request a fresh token from `POST /api/delivery/token`
3. Check system clocks are synchronized (NTP)

### "Nonce already used" errors

1. Client is replaying a single-use token
2. If legitimate: client should request a fresh token for each request
3. This may indicate token theft if unexpected