# Security Policy

## Reporting a Vulnerability
If you discover a potential security vulnerability, please **do not open a public issue**. Instead, report it privately via email to ensure the safety of our users.

**Email:** security@eduvault.io (or your-email@example.com)

## Security Model
EduVault is a non-custodial platform:
- **Private Keys:** We never store or transmit private keys. Wallet interactions happen client-side via Reown/AppKit.
- **Transactions:** Users must manually approve all on-chain actions.
- **Infrastructure:** Sensitive keys are managed through secure environment variables.

## Scope
| Component | Status |
| :--- | :--- |
| EduVault Frontend | In Scope |
| EduVault API Routes | In Scope |
| Smart Contracts | In Scope |
| 3rd Party Services (Clerk, MongoDB) | Out of Scope |

## Data Export and Deletion
- Users can download their own data from `GET /api/profile/export`. The archive contains the profile document, purchases, learner notes, saved materials, reviews and material feedback linked to the account, plus export metadata.
- Users can request anonymisation with `DELETE /api/profile`. The request requires an active session and a fresh wallet signature issued for the `delete_profile` action.
- On deletion, profile PII (name, email, biography, avatar, social links, institution, country, payout details, phone and wallet identifier fields) is removed or replaced with non-identifying values. Reviews and material feedback are anonymised in place rather than deleted so ratings and counts remain consistent.
- Purchase, payment, transaction and entitlement records are retained for accounting, tax, dispute and fraud-prevention obligations. These financial records keep the transaction identifiers and amounts but are no longer linked from the anonymised profile document.
- Refresh tokens and outstanding auth challenges for the account are deleted, and authentication cookies are expired. Already-issued access tokens remain valid for at most 15 minutes, matching their configured lifetime.
- Export and deletion events are written to the audit log with a pseudonymous actor identifier. Audit logs are retained for security investigations and are not included in user exports.

## Disclosure Policy
We commit to acknowledging all reports within 48 hours and will work to resolve valid issues as quickly as possible.