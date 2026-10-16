# Entitlement Check Fallback Design

**Date:** 2026-09-27
**Author:** nonsobethel0-dev
**Issues:** #753

## Overview

Entitlement checks depend on querying an RPC endpoint (EVM node or Soroban/Horizon RPC). When that RPC is unavailable, the system must handle failures gracefully without granting unauthorized access.

## Design Principles

1. **Security first:** Never grant access during an outage
2. **Graceful degradation:** Serve from cache with bounded staleness
3. **Clear user messaging:** Distinct states for different failure modes
4. **Circuit breaker:** Prevent cascading failures

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Request    │────▶│ Entitlement  │────▶│   Cache      │
│              │     │   Service    │     │   Layer      │
└──────────────┘     └──────┬───────┘     └──────────────┘
                           │
                           ▼
                    ┌──────────────┐
                    │  Circuit     │
                    │  Breaker     │
                    └──────┬───────┘
                           │
                           ▼
                    ┌──────────────┐
                    │  RPC Client  │
                    │ (EVM/Soroban)│
                    └──────────────┘
```

## Cache Strategy

### Cache Structure
```typescript
interface EntitlementCacheEntry {
  userId: string;
  materialId: string;
  hasAccess: boolean;
  verifiedAt: number;      // Timestamp of last verification
  source: 'rpc' | 'cache'; // How this entry was obtained
}
```

### Staleness Bounds
- **Cache TTL:** 5 minutes (configurable)
- **Max staleness:** 15 minutes (hard limit)
- **During outage:** Serve from cache if < 15 minutes old

### Cache Invalidation
- On successful RPC verification: update cache
- On entitlement revocation: invalidate cache entry
- On refund: invalidate cache entry

## Circuit Breaker

### States
```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│    CLOSED   │────▶│     OPEN     │────▶│  HALF_OPEN   │
└─────────────┘     └──────────────┘     └──────────────┘
       ▲                                        │
       └────────────────────────────────────────┘
```

### Configuration
- **Failure threshold:** 5 consecutive failures
- **Open duration:** 30 seconds
- **Half-open probes:** 1 request

### Behavior
- **CLOSED:** Normal operation, requests pass through
- **OPEN:** All requests fail fast, serve from cache
- **HALF_OPEN:** Allow one probe request; close on success, reopen on failure

## User-Facing States

| State | HTTP Status | User Message |
|-------|-------------|--------------|
| Entitled | 200 | Access granted |
| Not entitled | 403 | "You don't have access to this material" |
| RPC unavailable | 503 | "Unable to verify access right now. Please try again shortly." |
| Cache expired | 403 | "Your access verification has expired. Please refresh." |

## Implementation

```typescript
class EntitlementService {
  private cache: EntitlementCache;
  private circuitBreaker: CircuitBreaker;
  private rpcClient: RPCClient;

  async checkEntitlement(userId: string, materialId: string): Promise<EntitlementResult> {
    // 1. Check cache first
    const cached = await this.cache.get(userId, materialId);
    if (cached && !this.isStale(cached)) {
      return { entitled: cached.hasAccess, source: 'cache' };
    }

    // 2. Check circuit breaker
    if (this.circuitBreaker.isOpen()) {
      // Serve from cache if within staleness bound
      if (cached && this.isWithinStalenessBound(cached)) {
        return { entitled: cached.hasAccess, source: 'cache', degraded: true };
      }
      return { entitled: false, source: 'circuit-breaker', degraded: true };
    }

    // 3. Query RPC
    try {
      const result = await this.rpcClient.checkEntitlement(userId, materialId);
      await this.cache.set(userId, materialId, result);
      this.circuitBreaker.recordSuccess();
      return { entitled: result, source: 'rpc' };
    } catch (error) {
      this.circuitBreaker.recordFailure();
      // Serve from cache if available
      if (cached) {
        return { entitled: cached.hasAccess, source: 'cache', degraded: true };
      }
      return { entitled: false, source: 'error', degraded: true };
    }
  }
}
```

## Testing

### Unit Tests
- Cache hit/miss scenarios
- Circuit breaker state transitions
- Staleness bound enforcement

### Integration Tests
- Simulated RPC outage (mock timeout)
- Cache refresh after outage recovery
- Concurrent requests during outage

### Chaos Tests
- Random RPC failures
- Network partitions
- Cache invalidation during outage
