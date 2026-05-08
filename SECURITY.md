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

## Disclosure Policy
We commit to acknowledging all reports within 48 hours and will work to resolve valid issues as quickly as possible.