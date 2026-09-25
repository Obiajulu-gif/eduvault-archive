export function verifySessionWalletAddress(sessionPayload, profileData) {
  if (!sessionPayload || !profileData) {
    return false;
  }

  const sessionWallet = sessionPayload.walletAddress || sessionPayload.sub;
  const targetWallet = profileData.walletAddress;

  if (targetWallet && sessionWallet) {
    return targetWallet.toLowerCase() === sessionWallet.toLowerCase();
  }

  return false;
}
