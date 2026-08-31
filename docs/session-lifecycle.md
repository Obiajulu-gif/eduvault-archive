# Session Lifecycle and Wallet Disconnect

This document defines the expected behavior of user sessions, authentication tokens, and wallet interactions within the EduVault platform.

## Architecture

EduVault uses a challenge-based authentication flow (via SIWS - Sign-In with Stellar) which issues an HTTP-only `auth_token` cookie. The presence and validity of this cookie dictates access to authenticated dashboard routes.

## Session Revocation Triggers

To prevent a user from inadvertently remaining authenticated after disconnecting their wallet, the frontend explicitly calls the backend logout endpoint (`POST /api/auth/logout`) under the following conditions:

1. **Manual Wallet Disconnect**: When a user clicks "Disconnect" in the UI, `StellarWalletsKit` emits a `DISCONNECT` event. The `WalletProvider` listens for this and triggers an API logout.
2. **Account Switching**: If the user switches their active account within their wallet extension, the `STATE_UPDATED` event fires with a new address. If this address differs from the currently connected session, the previous session is immediately revoked via API logout.
3. **Session Expiry**: The `auth_token` expires on its own after its set lifetime. `useSessionExpiry` tracks this client-side to prompt for refresh or clear state when it lapses.
4. **Manual Logout**: If a dedicated logout button is implemented, it explicitly targets the logout endpoint.

## Middleware Enforcement

Dashboard routes (`/dashboard/*`) are protected by Next.js `middleware.js`, which checks for the presence of the `auth_token` cookie. 
- If the token is missing, the request is redirected to the home page `/`. 
- This ensures that immediately upon wallet disconnect (which clears the cookie via the logout API), further navigation or data fetching on dashboard routes is blocked, without requiring manual browser storage cleanup by the user.

## Expected Behavior

| Action | Frontend State | Backend State | Dashboard Access |
| :--- | :--- | :--- | :--- |
| **Login** | Wallet connected, address stored in React state. | `auth_token` cookie set. | Allowed. |
| **Disconnect Wallet** | Wallet state cleared to Idle. | `auth_token` cookie cleared via `/api/auth/logout`. | Redirected to `/`. |
| **Switch Account** | Address updated to new account. | Old `auth_token` cleared. Re-auth required for new address. | Redirected to `/` until re-authenticated. |
| **Session Expiry** | Expiry timer reaches 0. | `auth_token` expires naturally (or refresh token rotated). | Redirected to `/` if no refresh. |


## Manual Validation Steps

To manually validate the session lifecycle and logout flow:
1. Start the application and log in by connecting your wallet.
2. Verify you can access `/dashboard`.
3. Disconnect your wallet via the UI.
4. Attempt to navigate to `/dashboard` directly via the address bar. You should be redirected to `/`.
5. Connect your wallet again and log in.
6. Open your wallet extension and switch to a different account.
7. Attempt to navigate to `/dashboard` or perform an authenticated action. You should be redirected or prompted to re-authenticate with the new account.
8. (Optional) Check browser dev tools to ensure the `auth_token` cookie is absent after disconnect.

