# Email Subscriptions & Preference Management

This document describes the email subscription system, including security considerations, transactional vs. marketing classifications, and unsubscribe mechanisms.

## Architecture

### Preference Categories

Email preferences are managed via `emailSubscriptions` field on user documents. Each category is classified as either **transactional** (required for account/order integrity, always sent) or **marketing** (optional, respects user preferences).

#### Transactional Emails (Always Sent, Never Blocked by Preferences)

- **purchaseReceipts**: Sent when a purchase is confirmed on-chain. Buyer must receive proof of purchase regardless of marketing opt-out status.
- **buyConfirmations**: Notification when a buyer's transaction is confirmed (post-confirmation state change).

These are "required by law/business logic" and cannot be disabled.

#### Marketing/Optional Emails (Respect Subscription Preferences)

- **weeklyEarnings**: Weekly digest of creator earnings and payouts.
- **productUpdates**: Feature announcements, product improvements, marketplace news.
- **materialApproved**: Notification when uploaded material passes review.
- **newFollower**: Notification when someone follows a creator profile.

These are controlled by the user's `emailSubscriptions[key]` preference and can be disabled.

### API Endpoints

#### GET /api/profile/email-subscriptions

Returns current preferences for the authenticated user. Requires authentication.

Response:
```json
{
  "success": true,
  "emailSubscriptions": {
    "purchaseReceipts": true,
    "buyConfirmations": true,
    "weeklyEarnings": true,
    "productUpdates": false,
    "materialApproved": true,
    "newFollower": false
  }
}
```

#### PATCH /api/profile/email-subscriptions

Updates one or more preferences for the authenticated user. Requires authentication.

Request body:
```json
{
  "emailSubscriptions": {
    "productUpdates": false
  }
}
```

Response: Updated preferences (same shape as GET).

**Security**: The endpoint derives the target user strictly from the authenticated session (`getUserFromCookie`). Client-supplied user IDs in the request body are ignored. This prevents cross-account writes.

#### POST /api/email/unsubscribe (No Auth Required)

One-click unsubscribe link for marketing emails. Embedded in every marketing email as:
```
https://app.example.com/api/email/unsubscribe?token=<signed-token>
```

Takes a cryptographically signed, expiring token (30-day TTL) that encodes the email and preference key. No authentication required, allowing unsubscribe from a link in an email.

Request body:
```json
{
  "token": "<base64-encoded-signed-token>"
}
```

Response:
```json
{
  "success": true,
  "message": "You have been unsubscribed from this email type"
}
```

**Security**: 
- Token is HMAC-SHA256 signed with `UNSUBSCRIBE_TOKEN_SECRET` (environment variable, must be set in production)
- Token includes expiry (30 days); expired tokens are rejected
- Token signature cannot be forged without the secret
- For privacy, endpoint returns success even if email is not found (does not leak which emails are registered)

### Transactional vs. Marketing Classification

When sending emails, the intent payload includes `isTransactional: true` for purchase receipts:

```javascript
await enqueueSideEffect({
  type: 'email',
  channel: 'purchase_receipt',
  isTransactional: true, // Never check subscription preferences
  payload: { email, purchase, material },
});
```

The outbox/email-send logic must:
1. **Skip subscription checks** for `isTransactional: true` intents
2. **Check subscription preferences** for marketing intents (compare `intent.channel` against `emailSubscriptions[key]`)

## Implementation Checklist for New Email Types

When adding a new email notification type:

1. **Add the key to `ALLOWED_KEYS`** in `src/app/api/profile/email-subscriptions/route.js`

2. **Classify as transactional or marketing**:
   - Transactional: Order confirmations, password resets, account security events → include `isTransactional: true` in intent
   - Marketing: Newsletters, feature announcements, personalized recommendations → omit flag, will be checked against `emailSubscriptions[key]`

3. **For marketing emails, generate an unsubscribe token**:
   ```javascript
   import { generateUnsubscribeToken } from '@/lib/email/unsubscribeToken';
   
   const unsubscribeToken = generateUnsubscribeToken(email, 'newEmailCategory');
   const unsubscribeUrl = `${appUrl}/api/email/unsubscribe?token=${unsubscribeToken}`;
   // Include in email footer
   ```

4. **Document the category** in this file.

5. **Add a test** verifying:
   - Transactional emails are sent regardless of subscription state
   - Marketing emails respect subscription preferences
   - Unsubscribe link works and updates preferences

## Idempotency & Spoof-Resistant Webhook Handling (Issue #680)

`src/lib/email/subscriptionGuard.js` hardens the subscription workflow against
duplicate opt-ins and provider-webhook spoofing.

### Idempotent subscribe/unsubscribe

`applySubscriptionTransition({ db, email, preferenceKey, action, source, origin, verified })`
upserts a single canonical record keyed on `email::preferenceKey` (email
lower-cased). Duplicate opt-ins collapse into one document:

- **subscribe** stamps `consentAt` (never re-minted on a retry) and clears any
  `unsubscribedAt`.
- **unsubscribe** stamps `unsubscribedAt`/`unsubscribedSource` and clears
  `consentAt`.
- Every record records `source` and `origin`, so consent can be audited.

### Provider webhook signature verification

`verifyProviderWebhook({ body, signatureHeader, secret, toleranceSeconds })`
validates inbound provider events with an HMAC-SHA256 signature over
`"<timestamp>.<rawBody>"` (same wire format as the outbound webhook sender).
Rejects:

- Missing body / header / secret
- Non-numeric or stale timestamps (outside `toleranceSeconds`, default 300 s)
- Signature mismatches (constant-time comparison)

`signProviderWebhook(body, secret, timestamp)` is provided for parity/testing.

### Tests

`tests/backend/subscription-guard.test.mjs` covers duplicate-opt-in collapse,
subscribe→unsubscribe single-doc semantics, invalid signature rejection, valid
signature acceptance, stale-signature rejection, and canonical key handling.

## CAN-SPAM Compliance

This system supports CAN-SPAM and similar regulations by:

1. **Providing visible preference controls** (POST /api/profile/email-subscriptions)
2. **Sending transactional emails** (order confirmations, etc.) regardless of marketing opt-out
3. **One-click unsubscribe for marketing** (POST /api/email/unsubscribe, no login required)
4. **Signed, expiring tokens** prevent tampering and unauthorized unsubscribes

## Security Considerations

### Cross-Account Writes

✅ **Prevented**: The PATCH endpoint derives the target user from the authenticated session, never from client-supplied IDs in the request body.

### Transactional Email Separation

✅ **Enforced**: The `isTransactional` flag on email intents ensures purchase receipts can never be blocked by a marketing opt-out. The email-send logic must respect this flag.

### Unauthenticated Unsubscribe

✅ **Secured**: Tokens are cryptographically signed (HMAC-SHA256) and include a 30-day expiry. The token encodes the email and preference key; the signature ensures neither can be forged without `UNSUBSCRIBE_TOKEN_SECRET`.

### Rate Limiting

✅ **Applied**: The PATCH endpoint includes rate limiting (30 requests/minute per user via `withApiHardening`).

## Testing

Run preference/unsubscribe tests:
```bash
npm test -- src/app/api/profile/email-subscriptions
npm test -- src/lib/email
```

Test scenarios:
- Authenticated user can view and update their preferences
- Unauthenticated requests are rejected
- Cross-account write attempts are rejected
- Transactional emails are sent regardless of opt-out
- One-click unsubscribe link works and updates preferences
- Expired/forged unsubscribe tokens are rejected
