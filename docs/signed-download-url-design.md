# Signed Download URL Design

**Date:** 2026-09-27
**Author:** nonsobethel0-dev
**Issues:** #752

## Overview

This document designs a mechanism to issue secure, time-limited download URLs tied to on-chain entitlement checks. The URLs must be convenient (browser-friendly) while preventing unauthorized sharing.

## Design Goals

1. **Security:** URLs cannot be shared or reused after entitlement revocation
2. **Convenience:** Works in browsers without wallet signatures on each click
3. **Auditability:** All issuances are logged for abuse detection
4. **Revocation:** Entitlement changes invalidate previously issued URLs

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Buyer      │────▶│   Backend    │────▶│  Entitlement │
│   Request    │     │   Service    │     │    Check     │
└──────────────┘     └──────┬───────┘     └──────────────┘
                           │
                           ▼
                    ┌──────────────┐
                    │  URL Issuer  │
                    │  (Signed)    │
                    └──────┬───────┘
                           │
                           ▼
                    ┌──────────────┐
                    │  Storage     │
                    │  (IPFS/S3)   │
                    └──────────────┘
```

## URL Format

```
https://cdn.eduvault.com/download/{materialId}/{token}?signature={sig}&expires={ts}
```

### Token Structure
```
{userId}:{materialId}:{expiresAt}:{nonce}
```

- `userId`: Buyer's wallet address
- `materialId`: Material identifier
- `expiresAt`: Unix timestamp (5 minutes from issuance)
- `nonce`: Random string for uniqueness

### Signature
```
HMAC-SHA256(token, SECRET_KEY)
```

## Implementation

### URL Issuance

```typescript
class DownloadUrlService {
  private secret: string;
  private entitlementService: EntitlementService;
  private storageClient: StorageClient;

  async issueDownloadUrl(
    userId: string,
    materialId: string,
    ip: string
  ): Promise<DownloadUrlResult> {
    // 1. Verify entitlement
    const entitlement = await this.entitlementService.checkEntitlement(userId, materialId);
    if (!entitlement.entitled) {
      throw new ForbiddenError('Not entitled to this material');
    }

    // 2. Check revocation
    if (await this.isRevoked(userId, materialId)) {
      throw new ForbiddenError('Entitlement has been revoked');
    }

    // 3. Rate limit check
    if (await this.isRateLimited(userId, materialId)) {
      throw new TooManyRequestsError('Download limit reached');
    }

    // 4. Generate signed URL
    const nonce = crypto.randomBytes(16).toString('hex');
    const expiresAt = Math.floor(Date.now() / 1000) + 300; // 5 minutes
    const token = `${userId}:${materialId}:${expiresAt}:${nonce}`;
    const signature = crypto.createHmac('sha256', this.secret).update(token).digest('hex');

    // 5. Get storage path
    const storagePath = await this.storageClient.getPath(materialId);

    // 6. Log issuance
    await this.logIssuance({ userId, materialId, ip, expiresAt });

    // 7. Return URL
    return {
      url: `https://cdn.eduvault.com/download/${materialId}/${token}?signature=${signature}&expires=${expiresAt}`,
      expiresAt,
    };
  }

  async validateDownloadUrl(url: string, ip: string): Promise<ValidationResult> {
    // 1. Parse URL components
    const { token, signature, materialId } = this.parseUrl(url);

    // 2. Verify signature
    const expectedSignature = crypto.createHmac('sha256', this.secret).update(token).digest('hex');
    if (signature !== expectedSignature) {
      return { valid: false, reason: 'invalid_signature' };
    }

    // 3. Check expiry
    const { userId, expiresAt } = this.parseToken(token);
    if (Date.now() / 1000 > expiresAt) {
      return { valid: false, reason: 'expired' };
    }

    // 4. Check revocation
    if (await this.isRevoked(userId, materialId)) {
      return { valid: false, reason: 'revoked' };
    }

    // 5. Log access
    await this.logAccess({ userId, materialId, ip });

    return { valid: true, userId, materialId };
  }
}
```

## Rate Limiting

### Per-User Limits
- **Issuance:** 10 URLs per hour per user
- **Download:** 50 downloads per hour per user

### Abuse Detection
- Log all issuances with IP and timestamp
- Alert on suspicious patterns (> 20 issuances/hour from single IP)
- Block IPs with repeated abuse

## Revocation Integration

When entitlement is revoked:
1. Add `(userId, materialId)` to revocation set
2. Set TTL to match maximum URL expiry (5 minutes)
3. All subsequent URL validations check revocation set

## Security Considerations

1. **Secret rotation:** Rotate SECRET_KEY periodically; old URLs remain valid until expiry
2. **URL exposure:** Never log full URLs; log only token hash
3. **Storage abstraction:** Never expose raw IPFS CIDs or S3 paths to clients
4. **Audit trail:** Log all issuance and access events for compliance
