import { getUserFromCookie } from "../api/auth.js";
import { normalizeWalletAddress } from "./walletAddress.js";

export { normalizeWalletAddress } from "./walletAddress.js";

/** Resolve wallet identity only from the verified, signed auth session. */
export async function resolveAuthenticatedWallet(request) {
  const session = await getUserFromCookie(request);
  if (!session) return { ok: false, status: 401, error: "Authentication required" };

  // For accounts with multiple wallets, auth sets activeWalletAddress when
  // the user explicitly switches. Never infer identity from query/body/header.
  const walletAddress = normalizeWalletAddress(
    session.activeWalletAddress || session.walletAddress || session.address,
  );
  if (!walletAddress) {
    return { ok: false, status: 403, error: "No valid wallet bound to this session" };
  }
  return { ok: true, walletAddress, session };
}
