Session lifecycle and logout behavior

Overview
- The backend issues an `auth_token` HTTP-only cookie on profile lookup or creation. This cookie is used to authorize dashboard and protected API routes.
- A new logout endpoint exists at `/api/logout` which clears the `auth_token` cookie using the same `httpOnly`, `sameSite`, `secure`, and `path` settings.

Frontend behavior
- The WalletProvider implementation (`src/providers/WalletProvider.jsx`) now calls `/api/logout` when the wallet is disconnected or when the connected account changes. This ensures the server-side session is revoked and dashboard access is removed.

Expected behaviors
- Wallet disconnect: triggers `/api/logout`, then disconnects the wallet. Dashboard routes should reject/redirect immediately.
- Account switch: when the wallet address changes, the frontend calls `/api/logout` to avoid silently keeping the previous session active. The user must re-authenticate for the new account.
- Manual logout: calling `/api/logout` clears the cookie and ends the session.
- Expired sessions: JWT expiry remains enforced by server-side verification (middleware and API handlers). Expired cookies will be treated as unauthenticated.

Validation / Manual test steps
1. Start the app locally on a host that supports cookies (e.g., `localhost`).
2. Create or lookup a profile to obtain an `auth_token` cookie (visit the dashboard to confirm access).
3. In the browser, use the wallet connect UI to disconnect the wallet. Verify that the dashboard no longer loads (redirected) without clearing site storage.
4. Repeat: connect wallet A, authenticate, then switch to wallet B via your wallet provider UI. Confirm the app calls `/api/logout` (network tab) and the dashboard is unauthenticated.
5. Call GET `/api/logout` or POST `/api/logout` directly and confirm the cookie is removed (network response shows Set-Cookie with max-age=0).

Notes for contributors
- The logout route intentionally mirrors the cookie attributes used when issuing `auth_token` to ensure proper deletion across environments.
- If you later implement server-side session storage or a revocation list, add revocation logic to `/api/logout` and to any token-issuing endpoints.
