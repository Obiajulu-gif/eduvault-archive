# Browser security baseline

Production uses a new CSP nonce per response. Scripts and style elements require
the nonce; `unsafe-eval` and inline scripts are disabled. Trusted Types permits
only Next.js runtime policies. Connect, image, media, form, and frame targets are
allowlisted in `src/lib/security/csp.js`.

`src/lib/security/input.js` normalizes server-side text, HTTPS URLs, redirects,
filenames, and remote images. User SVG and non-allowlisted image hosts are rejected.

Session cookies remain `HttpOnly`, `SameSite=Strict`, path-scoped, short-lived,
and `Secure` in production. Access tokens last 15 minutes; seven-day refresh
tokens are restricted to `/api/auth/refresh` and rotate on use.

Responses enforce HSTS, `nosniff`, framing denial, strict-origin referrers,
restricted permissions, COOP `same-origin-allow-popups`, COEP `credentialless`,
and CORP `same-origin`. Test wallet popups, checkout, uploads, images, and downloads
before changing isolation policies.

`/api/csp-report` caps payloads, strips query data, samples 10% by default via
`CSP_REPORT_SAMPLE_RATE`, and deduplicates reports for ten minutes. Wallet signing
parses XDR and verifies the displayed network, source, operation, recipient or
contract, asset, and amount; mismatches and cancelled reviews never reach the wallet.
