# Security Policy

## Reporting a Vulnerability
If you discover a potential security vulnerability, please **do not open a public issue**. Instead, report it privately via email to ensure the safety of our users.

**Email:** security@eduvault.io (or your-email@example.com)

## Security Model
EduVault is a non-custodial platform:
- **Private Keys:** We never store or transmit private keys. Wallet interactions happen client-side via Reown/AppKit.
- **Transactions:** Users must manually approve all on-chain actions.
- **Infrastructure:** Sensitive keys are managed through secure environment variables.

## Rate-Limiting Trust Model
API rate limits are enforced by `withApiHardening` (src/lib/api/hardening.js). Client identification uses the following trust hierarchy:

| Header | Trusted? | Notes |
| :--- | :--- | :--- |
| `x-vercel-forwarded-for` | Always | Injected by Vercel's edge network; not overwritable by clients. |
| `x-real-ip` | Only with `TRUSTED_PROXY_COUNT` env | Trusted only when a known reverse proxy strips client forwarding headers. |
| `x-forwarded-for` | **Never** | Client-controllable; never used for rate-limit bucketing. |
| `x-real-ip` (no proxy) | **Never** | Falls back to metadata-based composite key. |

When no trusted IP header is available, the rate limiter derives a per-caller bucket from semi-stable request metadata (user-agent + accept-language), preventing a single shared "local" bucket while still resisting header-spoofing resets.

**Environment variables:**
- `TRUSTED_PROXY_COUNT` — Set to a positive integer when deploying behind a reverse proxy that overwrites `x-real-ip`. Only set this when you control the proxy layer.

## Scope
| Component | Status |
| :--- | :--- |
| EduVault Frontend | In Scope |
| EduVault API Routes | In Scope |
| Smart Contracts | In Scope |
| 3rd Party Services (Clerk, MongoDB) | Out of Scope |

## Disaster Recovery Key Management & Entitlement Security (#715)
Disaster recovery procedures must enforce zero-trust entitlement security and strict secret isolation:
- **Decryption Key Verification:** During restore verification drills (`scripts/restore-verification.mjs`), `JWT_SECRET` must be present and validated for minimum key length (≥ 32 characters).
- **Zero-Trust Access Probes:** Restored data must be validated against entitlement decision probes to ensure unentitled callers receive no access leaks and revoked/refunded buyers cannot decrypt materials.
- **Secret Isolation:** Production secrets must never be logged or saved in unencrypted restore drill output. Restore drills must take place in isolated staging environments.

## Audit Logs & Access Reasons (#712)
Access to protected material is explicitly audited with reason codes to allow creators and maintainers to investigate access patterns and identify potential leaks or unauthorized support access. 
- **Reason Codes:** The system distinguishes between `preview` (publicly accessible chunks or low-res versions), `buyer_download` (entitled purchaser), `admin_review` (platform administration and moderation), and `support` (explicitly granted support access).
- **Redaction:** Sensitive tokens (e.g. Bearer tokens, capability tokens) and URLs in audit logs are redacted before being recorded to standard output.

## Disclosure Policy
We commit to acknowledging all reports within 48 hours and will work to resolve valid issues as quickly as possible.